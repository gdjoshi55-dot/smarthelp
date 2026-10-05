import { ApiHttpError, handle, ok } from '@/lib/api';
import { parseAvailabilityQuery } from '@/lib/validation';
import { resolveLocationForRequest } from '@/lib/catalogueServer';
import { getAvailability, resolveServiceability } from '@/lib/availabilityServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/availability — the slots for one service, one day, one duration.
 *
 * Parameters come straight from §27.4: `serviceId`, `addressId` (or `lat`/`lng`,
 * or `area`), `date`, `duration`, `professionalId`.
 *
 * Two failure modes worth naming, because they mean different things to the
 * person looking at the screen:
 *
 *   422 SERVICE_UNAVAILABLE — the locality is not covered for this service. Not
 *     a busy calendar; the service does not run there. The Phase 0 seed makes
 *     this reachable by leaving three outer localities with two categories each.
 *   200 with `slots: []`  — it runs there, and there is nothing free on that
 *     date. The client says so in those words.
 *
 * `slots` carries every candidate, `bookable` and not, with a `reason` on the
 * ones that are not. A slot the server will not offer always comes with the
 * sentence explaining itself.
 */
export async function GET(req: Request) {
  return handle(req, 'availability', async () => {
    const url = new URL(req.url);
    const query = parseAvailabilityQuery(url);

    const { summary, locality } = await resolveLocationForRequest(req, url);
    if (!locality) {
      throw new ApiHttpError(
        'VALIDATION_ERROR',
        'That location is not one we serve yet, so there are no slots to show.',
        422,
        { location: summary, reason: 'outside_coverage' }
      );
    }

    const serviceable = await resolveServiceability(query.serviceId, locality);
    const result = await getAvailability({
      serviceId: query.serviceId,
      serviceable,
      date: query.date,
      duration: query.duration,
      professionalId: query.professionalId,
    });

    return ok({
      ...result,
      location: summary,
      serverNow: result.day.serverNow,
    });
  });
}
