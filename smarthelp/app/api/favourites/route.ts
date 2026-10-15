import { created, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { requireCustomer } from '@/lib/addressServer';
import { addFavourite, listFavourites } from '@/lib/favouriteServer';
import { createServerClient } from '@/lib/supabaseServer';
import { oneOf, readJson, uuid } from '@/lib/validation';
import type { FavouriteTargetType } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TARGET_TYPES = ['service', 'professional'] as const;

/**
 * GET /api/favourites — the caller's saved services and professionals (§25.4).
 *
 * Customer-scoped: the list is filtered by the resolved `customers.id` in the
 * module, never by a query string, and each row is resolved to a named target.
 */
export async function GET(req: Request) {
  return handle(req, 'favourites.list', async () => {
    const { customer } = await requireCustomer(req);
    const result = await listFavourites(customer.id);
    return ok(result);
  });
}

/**
 * POST /api/favourites — save a service or a professional (§25.4).
 *
 * Idempotent: saving the same target twice returns `200` with `alreadySaved`,
 * distinct from the `201` of a fresh row. The target is checked to exist first,
 * so a favourite never points at nothing.
 */
export async function POST(req: Request) {
  return handle(req, 'favourites.add', async (requestId) => {
    const { auth, customer } = await requireCustomer(req);
    const body = await readJson(req);

    const targetType = oneOf(body.targetType, 'targetType', TARGET_TYPES) as FavouriteTargetType;
    const targetId = uuid(body.targetId, 'targetId');

    const supabase = createServerClient();
    const { favourite, alreadySaved } = await addFavourite(customer.id, targetType, targetId, supabase);

    if (!alreadySaved) {
      await audit(supabase, {
        actorProfileId: auth.userId,
        action: 'favourite.add',
        entityType: 'favourites',
        entityId: favourite.id,
        metadata: { target_type: targetType, target_id: targetId },
        ipAddress: clientIp(req),
        requestId,
      });
    }

    return alreadySaved ? ok({ favourite, alreadySaved }) : created({ favourite, alreadySaved });
  });
}
