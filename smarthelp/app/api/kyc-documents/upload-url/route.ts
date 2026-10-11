import { ApiHttpError, handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import { requireProfessional } from '@/lib/professionalServer';
import { fail, oneOf, str } from '@/lib/validation';
import {
  KYC_ALLOWED_MIME_TYPES,
  KYC_MAX_UPLOAD_BYTES,
  KYC_REQUIRED_DOC_TYPES,
} from '@/lib/constants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BUCKET = 'kyc-documents';

/**
 * POST /api/kyc-documents/upload-url — mint a signed upload URL (§24.15, P4-01).
 *
 * The path is the tenant boundary (Pitfall 10). It is built *server-side* from
 * the authenticated professional's own id — `${professionalId}/${docType}/${file}`
 * — and never taken from the body, because a client that could name the folder
 * could write into another professional's slot. The bucket's insert policy
 * (`kyc_insert_own`, 0025) checks the same first folder segment against
 * `current_professional_id()`, so a route that got this wrong would still be
 * refused by storage; the route is what makes the refusal a clean 400 rather
 * than a confusing storage error.
 *
 * Size and MIME are checked against the *declared* values the browser sends.
 * A signed URL cannot enforce bytes, so this is a courtesy refusal that gives a
 * readable message; the bucket's `file_size_limit` and `allowed_mime_types`
 * (0000) are the real backstop, and the page pre-checks the same two numbers.
 */
export async function POST(req: Request) {
  return handle(req, 'kyc.upload_url', async () => {
    const { professional } = await requireProfessional(req);
    const body = await readBody(req);

    const docType = oneOf(body.docType, 'docType', KYC_REQUIRED_DOC_TYPES);
    const filename = safeFilename(body.filename);
    const contentType = oneOf(body.contentType, 'contentType', KYC_ALLOWED_MIME_TYPES);
    const size = Number(body.size);
    if (!Number.isFinite(size) || size <= 0 || size > KYC_MAX_UPLOAD_BYTES) {
      fail({ size: 'Use a photo or PDF under 5 MB.' }, 'That file could not be uploaded.');
    }

    const path = `${professional.id}/${docType}/${filename}`;
    const supabase = createServerClient();

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(path);

    if (error || !data) {
      throw new ApiHttpError(
        'INTERNAL_ERROR',
        'We could not prepare the upload. Please try again.',
        500
      );
    }

    return ok({ path: data.path, token: data.token, signedUrl: data.signedUrl });
  });
}

/**
 * A filename safe to place in a storage path.
 *
 * Separators and `..` are the whole attack — a name like `../other/file.jpg`
 * would otherwise climb out of the caller's folder — so anything that is not a
 * plain name character is replaced. The extension survives, because storage
 * uses it to serve the object back with the right content type.
 */
function safeFilename(value: unknown): string {
  const raw = str(value, 'filename', { max: 128 });
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  if (cleaned.length === 0) {
    fail({ filename: 'Choose a file to upload.' });
  }
  return cleaned;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
