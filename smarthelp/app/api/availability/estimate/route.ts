import { ApiHttpError, handle, ok } from '@/lib/api';
import { parseLocationQuery, uuid } from '@/lib/validation';
import { resolveLocationForRequest } from '@/lib/catalogueServer';
import { getInstantEstimate, resolveServiceability } from '@/lib/availabilityServer';
import { etaLabel } from '@/lib/availability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/availability/estimate — "as soon as possible".
 *
 * `?serviceId=&addressId=` (or coordinates, or an area), optionally `duration`.
 * Answers `{ etaMinutes, prosAvailable, start, etaLabel }` for the instant
 * booking card.
 *
 * `etaMinutes: null` is a real answer: nothing is free for the rest of today in
 * that locality. It is returned as 200 with `etaLabel: 'No slots today'` rather
 * than as an error, because the card renders that sentence rather than an
 * error boundary.
 */
export async function GET(req: Request) {
  return handle(req, 'availability.estimate', async () => {
    const url = new URL(req.url);
    const serviceId = uuid(url.searchParams.get('serviceId'), 'serviceId');
    const durationRaw = url.searchParams.get('duration');
    const duration =
      durationRaw !== null && durationRaw !== '' ? Number(durationRaw) : undefined;

    if (duration !== undefined && (!Number.isInteger(duration) || duration < 15 || duration > 720)) {
      throw new ApiHttpError('VALIDATION_ERROR', 'Duration must be between 15 and 720 minutes.', 400, {
        fields: { duration: 'Out of range' },
      });
    }

    // The shared location parser is used for its coordinate pairing rule; this
    // endpoint has no `date`, so nothing else from it applies.
    parseLocationQuery(url, { required: true });

    const { summary, locality } = await resolveLocationForRequest(req, url);
    if (!locality) {
      return ok({
        etaMinutes: null,
        prosAvailable: 0,
        start: null,
        etaLabel: 'No slots today',
        location: summary,
        serverNow: new Date().toISOString(),
      });
    }

    const serviceable = await resolveServiceability(serviceId, locality);
    if (!serviceable.ok) {
      return ok({
        etaMinutes: null,
        prosAvailable: 0,
        start: null,
        etaLabel: `Not offered in ${locality.name}`,
        location: summary,
        serviceable,
        serverNow: new Date().toISOString(),
      });
    }

    const estimate = await getInstantEstimate(serviceId, serviceable, duration);

    return ok({
      ...estimate,
      etaLabel: etaLabel(estimate.etaMinutes),
      location: summary,
      serviceable,
      serverNow: new Date().toISOString(),
    });
  });
}
