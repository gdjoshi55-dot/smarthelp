import { handle, ok } from '@/lib/api';
import { oneOf, parsePaging, requireAuth, str } from '@/lib/validation';
import { createServerClient } from '@/lib/supabaseServer';
import { listAdminProfessionals } from '@/lib/adminServer';
import type { Database, UserRole, VerificationStatus } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

const VERIFICATION_STATUSES = [
  'not_submitted',
  'submitted',
  'in_review',
  'verified',
  'rejected',
  'expired',
] as const;

const AVAILABILITY_STATUSES = ['offline', 'online', 'busy', 'break'] as const;

/**
 * GET /api/admin/professionals — the professional roster (§20.13).
 *
 * Filterable by verification status, availability, and a name substring, and
 * paginated. A name search resolves against `profiles` in `listAdminProfessionals`
 * before it touches `professionals`, so an unmatched name is an empty page
 * rather than a full one.
 */
export async function GET(req: Request) {
  return handle(req, 'admin.professionals.list', async () => {
    await requireAuth(req, [...STAFF]);
    const url = new URL(req.url);
    const { limit, offset } = parsePaging(url);

    const verification = url.searchParams.get('verificationStatus');
    const availability = url.searchParams.get('availabilityStatus');
    const q = url.searchParams.get('q');
    const pendingKyc = ['1', 'true'].includes(url.searchParams.get('pendingKyc') ?? '');

    const result = await listAdminProfessionals(
      {
        verificationStatus: verification
          ? (oneOf(verification, 'verificationStatus', VERIFICATION_STATUSES) as VerificationStatus)
          : undefined,
        availabilityStatus: availability
          ? (oneOf(availability, 'availabilityStatus', AVAILABILITY_STATUSES) as Database['public']['Enums']['availability_status'])
          : undefined,
        q: q ? str(q, 'q', { max: 80 }) : undefined,
        pendingKyc,
        limit,
        offset,
      },
      createServerClient()
    );

    return ok(result);
  });
}
