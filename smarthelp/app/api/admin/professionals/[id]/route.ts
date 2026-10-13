import { ApiHttpError, handle, ok } from '@/lib/api';
import { requireAuth, uuid } from '@/lib/validation';
import { createServerClient } from '@/lib/supabaseServer';
import { getAdminProfessional } from '@/lib/adminServer';
import type { UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

/**
 * GET /api/admin/professionals/:id — one professional's file (§20.13).
 *
 * The profile, the KYC documents, the skills and the last ten jobs. A missing
 * id is a 404 and writes nothing (D3). The verification verdicts on the
 * documents are written by the Phase 4 KYC endpoint, not here; this is the read
 * the review queue (Wave B) is built on.
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.professionals.get', async () => {
    await requireAuth(req, [...STAFF]);
    const professionalId = uuid(params.id, 'id');

    const detail = await getAdminProfessional(professionalId, createServerClient());
    if (!detail) {
      throw new ApiHttpError('NOT_FOUND', 'That professional was not found.', 404);
    }

    return ok(detail);
  });
}
