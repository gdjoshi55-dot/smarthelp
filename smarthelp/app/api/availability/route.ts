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
    let query;
    try {
      query = parseAvailabilityQuery(url);
    } catch (err: any) {
      const serviceId = url.searchParams.get('serviceId');
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      let service: any = { id: serviceId, name: 'Service', slug: '', minDurationMinutes: 15, maxDurationMinutes: 720 };
      if (serviceId) {
        try {
          const { createServerClient } = await import('@/lib/supabaseServer');
          const supabase = createServerClient();
          const { data } = await supabase.from('services').select('id,name,slug,min_duration_min,max_duration_min').eq('id', serviceId).maybeSingle();
          if (data) service = { id: data.id, name: data.name, slug: data.slug, minDurationMinutes: data.min_duration_min, maxDurationMinutes: data.max_duration_min };
        } catch {}
      }
      return ok({
        service,
        location: { localityId: null, localityName: null, timeZone: 'Asia/Kolkata' },
        day: { date, timeZone: 'Asia/Kolkata', slots: [], eligibleCount: 0, busyCount: 0, serverNow: new Date().toISOString() },
      });
    }

    try {
      const { summary, locality } = await resolveLocationForRequest(req, url);
      if (!locality) {
        throw new ApiHttpError(
          'SERVICE_UNAVAILABLE',
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
    } catch (err: any) {
      if (err instanceof ApiHttpError && err.code === 'SERVICE_UNAVAILABLE') {
        const date = query.date || new Date().toISOString().slice(0, 10);
        let service: any = { id: query.serviceId, name: 'Service', slug: '', minDurationMinutes: 15, maxDurationMinutes: 720 };
        try {
          const { createServerClient } = await import('@/lib/supabaseServer');
          const supabase = createServerClient();
          const { data } = await supabase.from('services').select('id,name,slug,min_duration_min,max_duration_min').eq('id', query.serviceId).maybeSingle();
          if (data) service = { id: data.id, name: data.name, slug: data.slug, minDurationMinutes: data.min_duration_min, maxDurationMinutes: data.max_duration_min };
        } catch {}
        return ok({
          service,
          location: { localityId: null, localityName: null, timeZone: 'Asia/Kolkata' },
          day: { date, timeZone: 'Asia/Kolkata', slots: [], eligibleCount: 0, busyCount: 0, serverNow: new Date().toISOString() },
        });
      }
      throw err;
    }
  });
}
