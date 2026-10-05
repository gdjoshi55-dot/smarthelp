import { handle, ok } from '@/lib/api';
import { getLanding } from '@/lib/catalogueServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/landing — the public landing page's payload (§20.1).
 *
 * One request instead of four: categories, featured services, where we operate,
 * and how many verified professionals there are. Anonymous — the landing page is
 * the first thing somebody sees, and it has to render before they sign in.
 */
export async function GET(req: Request) {
  return handle(req, 'landing', async () => {
    const landing = await getLanding();
    return ok({ ...landing, serverNow: new Date().toISOString() });
  });
}
