import { handle, ok } from '@/lib/api';
import { listLocalities } from '@/lib/adminCatalogServer';
import { createServerClient } from '@/lib/supabaseServer';
import { requireAuth, str } from '@/lib/validation';
import type { UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

/**
 * GET /api/admin/localities — the picker behind the service-areas editor
 * (§7, §31.1). Reads are staff-wide; only `service.manage` can attach one.
 */
export async function GET(req: Request) {
  return handle(req, 'admin.localities.list', async () => {
    await requireAuth(req, [...STAFF]);
    const url = new URL(req.url);
    const q = url.searchParams.get('q');
    const localities = await listLocalities(q ? str(q, 'q', { max: 60 }) : undefined, createServerClient());
    return ok({ localities });
  });
}