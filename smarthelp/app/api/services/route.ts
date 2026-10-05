import { handle, ok } from '@/lib/api';
import { parseCatalogueQuery } from '@/lib/validation';
import { getCatalogue, resolveLocationForRequest } from '@/lib/catalogueServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/services — the catalogue (§20.2).
 *
 * Anonymous. `q`, `category` and the location parameters are all optional, and
 * the answer without a location is the whole catalogue with `serviceable: null`
 * on every card — "available where?" is a question the client asks, not one it
 * may assume.
 *
 * `availableOnly` defaults to true *when a locality was resolved*, which is what
 * §20.2 asks for: services not available where you are are out of the default
 * view. Passing `availableOnly=false` brings them back with a "Not in your area"
 * badge, so a customer can still see what exists and why it is not for them.
 */
export async function GET(req: Request) {
  return handle(req, 'services', async () => {
    const url = new URL(req.url);
    const query = parseCatalogueQuery(url);
    const { summary, locality } = await resolveLocationForRequest(req, url);

    const services = await getCatalogue({
      q: query.q,
      category: query.category,
      locality,
      availableOnly: query.availableOnly ?? locality !== null,
    });

    return ok({
      services,
      location: summary,
      availableOnly: query.availableOnly ?? locality !== null,
      serverNow: new Date().toISOString(),
    });
  });
}
