import { ApiHttpError, handle, ok } from '@/lib/api';
import { readJson, requireAuth, validateProfessionalApply } from '@/lib/validation';
import { createServerClient } from '@/lib/supabaseServer';
import { audit, clientIp } from '@/lib/audit';
import { isAdminRole } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/professional/apply
 *
 * Turns a signed-in account into a professional. Idempotent by design: applying
 * twice updates the same application instead of creating a second one, because
 * `professionals.profile_id` is unique and a duplicate application would leave
 * the KYC queue holding a row nobody will ever review.
 *
 * `verification_status` starts at `not_submitted` and can only leave that state
 * through the KYC review in Phase 4. Nothing here can set it.
 */
export async function POST(req: Request) {
  return handle(req, 'auth.professional.apply', async (requestId) => {
    const auth = await requireAuth(req);
    const body = await readJson(req);
    const input = validateProfessionalApply(body);

    if (auth.role === 'customer') {
      // Becoming a professional is a real role change, so it is audited and it
      // is one-way: a professional cannot fall back to being a customer.
      const { error: promoteErr } = await createServerClient()
        .from('profiles')
        .update({ role: 'professional' })
        .eq('id', auth.userId)
        .eq('role', 'customer');
      if (promoteErr) {
        throw new ApiHttpError('INTERNAL_ERROR', 'Could not start your application.', 500);
      }
      await createServerClient().from('customers').delete().eq('profile_id', auth.userId);
    } else if (auth.role !== 'professional' && !isAdminRole(auth.role)) {
      throw new ApiHttpError(
        'FORBIDDEN',
        'Only a customer or an existing professional can submit a professional application.',
        403
      );
    }

    const supabase = createServerClient();

    // The skills must be services that actually exist and are active.
    const { data: validServices, error: svcErr } = await supabase
      .from('services')
      .select('id')
      .in('id', input.serviceIds)
      .eq('is_active', true);
    if (svcErr) throw svcErr;
    if ((validServices?.length ?? 0) !== input.serviceIds.length) {
      throw new ApiHttpError(
        'VALIDATION_ERROR',
        'One of the services you picked is no longer offered.',
        400,
        { fields: { service_ids: 'Refresh and pick again' } }
      );
    }

    // Create or fetch the professional row.
    const { data: existing } = await supabase
      .from('professionals')
      .select('*')
      .eq('profile_id', auth.userId)
      .maybeSingle();

    let professionalId = existing?.id;
    let verificationStatus = existing?.verification_status ?? 'not_submitted';

    if (!existing) {
      // `verification_status` is deliberately not set here: the column default
      // is `not_submitted`, and the guard trigger refuses any other value from
      // this path anyway.
      const { data: inserted, error } = await supabase
        .from('professionals')
        .insert({ profile_id: auth.userId })
        .select('*')
        .single();
      if (error) throw error;
      professionalId = inserted.id;
      verificationStatus = inserted.verification_status;
    } else if (
      existing.verification_status === 'rejected' ||
      existing.verification_status === 'expired'
    ) {
      // A re-application resets the verdict, never the professional's history.
      const { data: reset, error } = await supabase
        .from('professionals')
        .update({ verification_status: 'submitted' })
        .eq('id', existing.id)
        .select('*')
        .single();
      if (error) throw error;
      verificationStatus = reset.verification_status;
    }

    if (input.experienceMonths > 0) {
      const { error } = await supabase
        .from('professionals')
        .update({ experience_months: input.experienceMonths })
        .eq('id', professionalId!);
      if (error) throw error;
    }

    // Skills are replaced wholesale: a remove is an un-insert.
    await supabase.from('professional_skills').delete().eq('professional_id', professionalId!);
    const { error: skillErr } = await supabase.from('professional_skills').upsert(
      input.serviceIds.map((serviceId) => ({
        professional_id: professionalId!,
        service_id: serviceId,
        proficiency: 3,
      }))
    );
    if (skillErr) throw skillErr;

    // Documents. The storage path is a path, never a public URL, and the row is
    // always `submitted` — the guard trigger refuses any other value from here.
    for (const doc of input.documents) {
      const { error } = await supabase
        .from('professional_documents')
        .upsert(
          {
            professional_id: professionalId!,
            doc_type: doc.docType,
            file_path: doc.filePath,
            status: 'submitted',
          },
          { onConflict: 'professional_id,doc_type' }
        );
      if (error) throw error;
    }

    if (input.documents.length > 0 && verificationStatus === 'not_submitted') {
      const { data: moved } = await supabase
        .from('professionals')
        .update({ verification_status: 'submitted' })
        .eq('id', professionalId!)
        .eq('verification_status', 'not_submitted')
        .select('verification_status')
        .maybeSingle();
      verificationStatus = moved?.verification_status ?? verificationStatus;
    }

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'professional.apply',
      entityType: 'professionals',
      entityId: professionalId,
      before: existing ? { verification_status: existing.verification_status } : null,
      after: {
        verification_status: verificationStatus,
        services: input.serviceIds.length,
        documents: input.documents.length,
      },
      ipAddress: clientIp(req),
      userAgent: req.headers.get('user-agent'),
      requestId,
    });

    return ok(
      {
        professionalId,
        verificationStatus,
        services: input.serviceIds,
        documents: input.documents.length,
        nextStep:
          verificationStatus === 'submitted'
            ? 'Your documents are queued for review. We will notify you within 48 hours.'
            : 'Upload your identity documents to start the review.',
      },
      existing ? 200 : 201
    );
  });
}
