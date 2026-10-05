import { handle, ok, ApiHttpError } from '@/lib/api';
import { getServiceBySlug, resolveLocationForRequest } from '@/lib/catalogueServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/services/[slug] — one service, in full.
 *
 * Description, the scope contract (`service_tasks`, split into included and
 * excluded), the gallery, the active duration ladder with its price overrides,
 * and — when a location was supplied — whether this service can be booked there
 * and with what lead time.
 *
 * A deactivated service is a 404, not an empty object: `is_active` hides it from
 * search, and the one honest answer to a direct link to a retired service is
 * that it is not there.
 */
export async function GET(req: Request, { params }: { params: { slug: string } }) {
  return handle(req, 'services.detail', async () => {
    const url = new URL(req.url);
    const { summary, locality } = await resolveLocationForRequest(req, url);

    const service = await getServiceBySlug(params.slug, locality);
    if (!service) {
      throw new ApiHttpError('NOT_FOUND', 'That service is not available.', 404);
    }

    return ok({ service, location: summary, serverNow: new Date().toISOString() });
  });
}
