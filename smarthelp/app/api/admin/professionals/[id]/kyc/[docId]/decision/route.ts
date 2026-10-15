import { ApiHttpError, handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import { audit, clientIp } from '@/lib/audit';
import { notifyKycDecision } from '@/lib/notificationHooks';
import { optionalStr, requireAuth, uuid } from '@/lib/validation';
import type { VerificationStatus } from '@/lib/supabase';

const VERDICTS = ['verified', 'rejected'] as const;
type Verdict = (typeof VERDICTS)[number];

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF = ['admin', 'super_admin', 'ops'] as const;

/**
 * POST /api/admin/professionals/:id/kyc/:docId/decision — the KYC verdict (D2,
 * P4-02).
 *
 * Ships without a UI: Phase 6 builds the review queue on this endpoint, the same
 * API-without-UI pattern Phase 3 used. The trust boundary is staff-only — a
 * verdict flips a marketplace-wide `verification_status` — so the role check is
 * the first thing that happens, before any read or write.
 *
 * The verdict write and the roll-up are one RPC (`kyc_document_decision`, 0029):
 * it stamps `status`/`reviewed_by`/`reviewed_at`, re-derives the professional's
 * status from the required document set, and returns the result. The free-text
 * rejection note is *not* part of that RPC — the route owns it, because a note
 * is prose the reviewer typed, not a state transition.
 *
 * The `guard_professional_document_review` trigger (0005) refuses a verdict
 * write from a non-trusted session; the service-role client is trusted, so the
 * guard permits exactly this path and nothing else.
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string; docId: string } }
) {
  return handle(req, 'admin.kyc.decision', async (requestId) => {
    const auth = await requireAuth(req, [...STAFF]);
    const professionalId = uuid(params.id, 'id');
    const documentId = uuid(params.docId, 'docId');

    const body = await readBody(req);
    const verdict = readVerdict(body.verdict);
    const note = optionalStr(body.note, 'note', { max: 500 });

    const supabase = createServerClient();

    // The document must belong to the professional named in the path, or the
    // verdict is aimed at the wrong person. This is a 404, not a 400: it says
    // "no such document on this professional", which is what a stale console
    // needs to hear.
    const { data: document, error: readError } = await supabase
      .from('professional_documents')
      .select('id, professional_id, doc_type, status')
      .eq('id', documentId)
      .maybeSingle();
    if (readError) throw readError;
    if (!document || document.professional_id !== professionalId) {
      throw new ApiHttpError('NOT_FOUND', 'That document was not found on this professional.', 404);
    }

    const { data: rolledUp, error: rpcError } = await supabase.rpc('kyc_document_decision', {
      p_document_id: documentId,
      p_verdict: verdict,
      p_admin: auth.userId,
    });
    if (rpcError) throw rpcError;

    // A rejection carries the reviewer's reason back to the professional (§20.10
    // shows it on the KYC stepper). A verification clears any prior reason, which
    // the RPC already does. There is no separate internal-note column, so nothing
    // the professional must not see is ever stored here.
    if (verdict === 'rejected' && note) {
      const { error: noteError } = await supabase
        .from('professional_documents')
        .update({ rejection_reason: note })
        .eq('id', documentId);
      if (noteError) throw noteError;
    }

    const verificationStatus = (rolledUp ?? 'submitted') as VerificationStatus;

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: verdict === 'verified' ? 'kyc.document_verified' : 'kyc.document_rejected',
      entityType: 'professional_document',
      entityId: documentId,
      before: { status: document.status },
      after: { status: verdict, verificationStatus },
      metadata: { professionalId, docType: document.doc_type, note },
      ipAddress: clientIp(req),
      requestId,
    });

    // The professional hears the verdict (§27.5 KYC_APPROVED / KYC_REJECTED).
    // A rejection is per-document and always speaks; an approval only when the
    // roll-up actually reaches `verified`, so a second document does not
    // re-announce a status the professional already had.
    if (verdict === 'rejected') {
      await notifyKycDecision(professionalId, false, note ?? '');
    } else if (verificationStatus === 'verified') {
      await notifyKycDecision(professionalId, true);
    }

    return ok({ verificationStatus });
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * A verdict, or a 422.
 *
 * The plan fixes this refusal at 422 rather than the validator's usual 400:
 * the body is well-formed JSON with a present-but-wrong `verdict`, which is a
 * "cannot process this entity" rather than a "malformed request". `details.fields`
 * is still attached so the client's field-error path works unchanged.
 */
function readVerdict(value: unknown): Verdict {
  if (typeof value !== 'string' || !(VERDICTS as readonly string[]).includes(value)) {
    throw new ApiHttpError('VALIDATION_ERROR', 'Please correct the highlighted fields', 422, {
      fields: { verdict: `Must be one of: ${VERDICTS.join(', ')}` },
    });
  }
  return value as Verdict;
}
