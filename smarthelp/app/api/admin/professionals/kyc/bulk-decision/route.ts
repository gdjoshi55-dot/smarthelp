import { ApiHttpError, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { createServerClient } from '@/lib/supabaseServer';
import { optionalStr, requireAuth, uuid } from '@/lib/validation';
import type { UserRole, VerificationStatus } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'super_admin', 'ops'];

const VERDICTS = ['verified', 'rejected'] as const;
type Verdict = (typeof VERDICTS)[number];

/**
 * POST /api/admin/professionals/kyc/bulk-decision — verify or reject a whole
 * queue at once (§20.13).
 *
 * The single-document endpoint (Phase 4) is right for one careful review. The
 * queue, though, is reviewed in batches — "verify selected" against thirty
 * professionals is the workflow the spec names — and thirty sequential HTTP
 * round trips from the browser is the shape that invites a half-applied queue.
 *
 * The unit is the *professional*, not the document: each id's documents that
 * are still awaiting a verdict (`submitted`/`in_review`) each get one
 * `kyc_document_decision` call, the same RPC the single endpoint uses, so the
 * roll-up rule is identical. A rejection carries the reviewer's reason onto
 * every document it rejects, exactly as the single path does.
 *
 * Both the gate (staff) and the per-document audit match the single endpoint;
 * the only addition is `metadata.bulk`, so the trail shows how the verdict
 * arrived.
 */
export async function POST(req: Request) {
  return handle(req, 'admin.kyc.bulk-decision', async (requestId) => {
    const auth = await requireAuth(req, [...STAFF]);

    const body = await readBody(req);
    const professionalIds = readProfessionalIds(body.professionalIds);
    const verdict = readVerdict(body.verdict);
    const note = optionalStr(body.note, 'note', { max: 500 });
    if (verdict === 'rejected' && !note) {
      throw new ApiHttpError('VALIDATION_ERROR', 'Please correct the highlighted fields', 422, {
        fields: { note: 'A rejection needs a reason the professional can act on.' },
      });
    }

    const supabase = createServerClient();
    const ip = clientIp(req);

    const results: {
      professionalId: string;
      verificationStatus: VerificationStatus | null;
      documentsProcessed: number;
    }[] = [];

    for (const professionalId of professionalIds) {
      const { data: pending, error } = await supabase
        .from('professional_documents')
        .select('id, doc_type, status')
        .eq('professional_id', professionalId)
        .in('status', ['submitted', 'in_review']);
      if (error) throw error;

      let verificationStatus: VerificationStatus | null = null;

      for (const doc of pending ?? []) {
        const { data: rolledUp, error: rpcError } = await supabase.rpc('kyc_document_decision', {
          p_document_id: doc.id,
          p_verdict: verdict,
          p_admin: auth.userId,
        });
        if (rpcError) throw rpcError;
        verificationStatus = (rolledUp ?? verificationStatus) as VerificationStatus;

        if (verdict === 'rejected' && note) {
          const { error: noteError } = await supabase
            .from('professional_documents')
            .update({ rejection_reason: note })
            .eq('id', doc.id);
          if (noteError) throw noteError;
        }

        await audit(supabase, {
          actorProfileId: auth.userId,
          action: verdict === 'verified' ? 'kyc.document_verified' : 'kyc.document_rejected',
          entityType: 'professional_document',
          entityId: doc.id,
          before: { status: doc.status },
          after: { status: verdict, verificationStatus },
          metadata: { professionalId, docType: doc.doc_type, note, bulk: true },
          ipAddress: ip,
          requestId,
        });
      }

      results.push({
        professionalId,
        verificationStatus,
        documentsProcessed: (pending ?? []).length,
      });
    }

    return ok({ verdict, results });
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readProfessionalIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiHttpError('VALIDATION_ERROR', 'Please correct the highlighted fields', 422, {
      fields: { professionalIds: 'Select at least one professional.' },
    });
  }
  if (value.length > 100) {
    throw new ApiHttpError('VALIDATION_ERROR', 'Please correct the highlighted fields', 422, {
      fields: { professionalIds: 'At most 100 professionals per batch.' },
    });
  }
  const ids = value.map((v, i) => uuid(v, `professionalIds[${i}]`));
  return [...new Set(ids)];
}

function readVerdict(value: unknown): Verdict {
  if (typeof value !== 'string' || !(VERDICTS as readonly string[]).includes(value)) {
    throw new ApiHttpError('VALIDATION_ERROR', 'Please correct the highlighted fields', 422, {
      fields: { verdict: `Must be one of: ${VERDICTS.join(', ')}` },
    });
  }
  return value as Verdict;
}
