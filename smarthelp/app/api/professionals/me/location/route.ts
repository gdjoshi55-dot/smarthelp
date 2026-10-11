import { handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import { requireProfessional } from '@/lib/professionalServer';
import { PLATFORM_DEFAULTS } from '@/lib/constants';
import { latitude, longitude, readJson } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/professionals/me/location — the periodic location ping (§19.4, D6).
 *
 * The professional's device posts where it is while on a job; the customer's
 * track poll reads it back. This route is the writer half; the reader is
 * `/api/bookings/:id/track`.
 *
 * The throttle is deliberately stateless: there is no rate-limit table, so the
 * window is measured against the `location_updated_at` we already store. A ping
 * inside `proLocationThrottleSeconds` of the last accepted one is dropped
 * (`{ updated: false }`) rather than written — the battery cost of a location
 * fix is the thing worth saving, and a `false` is not an error the device needs
 * to react to.
 *
 * The server owns the timestamp, never the client: `location_updated_at` is
 * `now()` at write time, so a device with a skewed clock cannot make its pin
 * look fresher — or staler — than it is against the track payload's freshness
 * window.
 */
export async function POST(req: Request) {
  return handle(req, 'professionals.me.location', async () => {
    const { professional } = await requireProfessional(req);

    const body = await readJson(req);
    const lat = latitude(body.lat, 'lat');
    const lng = longitude(body.lng, 'lng');

    const windowMs = PLATFORM_DEFAULTS.proLocationThrottleSeconds * 1000;
    const last = professional.location_updated_at
      ? new Date(professional.location_updated_at).getTime()
      : null;
    if (last !== null && Number.isFinite(last) && Date.now() - last < windowMs) {
      return ok({ updated: false });
    }

    const supabase = createServerClient();
    const { error } = await supabase
      .from('professionals')
      .update({
        current_lat: lat,
        current_lng: lng,
        location_updated_at: new Date().toISOString(),
      })
      .eq('id', professional.id);
    if (error) throw error;

    return ok({ updated: true });
  });
}
