import { ApiHttpError, created, handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import { requireProfessional } from '@/lib/professionalServer';
import { fail, oneOf, str } from '@/lib/validation';
import { KYC_REQUIRED_DOC_TYPES } from '@/lib/constants';
import type { ProfessionalDocument } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The columns a professional may see on their own KYC documents.
 *
 * `file_path` is included because the page needs to know a file exists for a
 * step; the bytes are never fetched here. `rejection_reason` is the *feedback*
 * a reviewer leaves for the professional (§20.10) — there is no separate
 * internal-note column in `professional_documents`, so the "never show internal
 * reviewer notes" rule is satisfied by there being nothing internal to select.
 */
const DOC_COLUMNS =
  'id, doc_type, file_path, status, rejection_reason, reviewed_at, created_at';

/**
 * GET /api/professionals/me/kyc — the professional's verification state (§20.10).
 *
 * The roll-up status lives on `professionals.verification_status` and is set by
 * the `kyc_document_decision` RPC (0029); this read simply reports it alongside
 * the per-document rows the stepper renders.
 */
export async function GET(req: Request) {
  return handle(req, 'professionals.kyc.get', async () => {
    const { professional } = await requireProfessional(req);
    const supabase = createServerClient();

    const { data, error } = await supabase
      .from('professional_documents')
      .select(DOC_COLUMNS)
      .eq('professional_id', professional.id)
      .order('doc_type', { ascending: true });
    if (error) throw error;

    return ok({
      verificationStatus: professional.verification_status,
      kycVerifiedAt: professional.kyc_verified_at,
      documents: ((data ?? []) as ProfessionalDocument[]).map(toDocumentView),
    });
  });
}

/**
 * POST /api/professionals/me/kyc — record a submitted document (§20.10, P4-01).
 *
 * The body is `{ docType, filePath }`, where `filePath` is the object the
 * signed-URL route already minted. The path is re-checked here against the
 * caller's own folder prefix: a professional who guessed another slot's path
 * could not upload to it (storage refuses), but they could still hand the route
 * a path and get a row pointing at somebody else's object, so the row is
 * confined too.
 *
 * The write is an upsert on `(professional_id, doc_type)` — the one row the
 * `uniq_prof_doc` index allows — so re-uploading after a rejection replaces the
 * file and restarts review rather than colliding with the old row. The `0005`
 * review guard lets a professional replace an un-reviewed file; a verified or
 * in-review document is locked, and the trigger's `KYC_DOCUMENT_LOCKED` becomes
 * a 409 here rather than a 500.
 */
export async function POST(req: Request) {
  return handle(req, 'professionals.kyc.submit', async () => {
    const { professional } = await requireProfessional(req);
    const body = await readBody(req);

    const docType = oneOf(body.docType, 'docType', KYC_REQUIRED_DOC_TYPES);
    const filePath = str(body.filePath, 'filePath', { max: 512 });

    if (!filePath.startsWith(`${professional.id}/`)) {
      fail({ filePath: 'That upload does not belong to your account.' });
    }

    const supabase = createServerClient();
    const { data, error } = await supabase
      .from('professional_documents')
      .upsert(
        {
          professional_id: professional.id,
          doc_type: docType,
          file_path: filePath,
          status: 'submitted',
          rejection_reason: null,
        },
        { onConflict: 'professional_id,doc_type' }
      )
      .select(DOC_COLUMNS)
      .single();

    if (error) {
      if (typeof error.message === 'string' && error.message.includes('KYC_DOCUMENT_LOCKED')) {
        throw new ApiHttpError(
          'INVALID_STATE',
          'That document is already under review. Contact support to replace it.',
          409
        );
      }
      throw error;
    }

    return created({ document: toDocumentView(data as ProfessionalDocument) });
  });
}

function toDocumentView(row: ProfessionalDocument) {
  return {
    id: row.id,
    docType: row.doc_type,
    filePath: row.file_path,
    status: row.status,
    rejectionReason: row.rejection_reason,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
