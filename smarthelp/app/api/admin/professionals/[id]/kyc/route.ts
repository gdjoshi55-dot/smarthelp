import { ApiHttpError, handle, ok } from '@/lib/api';
import { requireAuth, uuid } from '@/lib/validation';
import { createServerClient } from '@/lib/supabaseServer';
import { getKycReview } from '@/lib/adminServer';
import type { UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'super_admin', 'ops'];

/**
 * GET /api/admin/professionals/:id/kyc — the KYC review payload (§20.13).
 *
 * The professional, their profile, their declared skills and each uploaded
 * document with a short-lived signed read URL. The bucket is private with no
 * select policy (0025), so this route is the only path to the bytes; the role
 * check happens before any URL is minted.
 *
 * A missing professional is a 404 and mints nothing (D3). The verdicts are
 * written by the Phase 4 decision endpoint — this is the read the review screen
 * is built on.
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.professionals.kyc', async () => {
    await requireAuth(req, [...STAFF]);
    const professionalId = uuid(params.id, 'id');

    const review = await getKycReview(professionalId, createServerClient());
    if (!review) {
      throw new ApiHttpError('NOT_FOUND', 'That professional was not found.', 404);
    }

    return ok(review);
  });
}
