import { handle, ok } from '@/lib/api';
import { categorySummaries, loadServiceContext } from '@/lib/catalogueServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/service-categories — the five category pills, with counts.
 *
 * Separate from `/api/services` because the landing page and the catalogue both
 * need the pills on their own, and a category list is the one catalogue query
 * that cannot be filtered, paged or searched — so it is worth a cache header
 * when the edge is wired up in Phase 9.
 */
export async function GET(req: Request) {
  return handle(req, 'service-categories', async () => {
    const categories = categorySummaries(await loadServiceContext());
    return ok({ categories });
  });
}
