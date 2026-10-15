import { handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { requireCustomer } from '@/lib/addressServer';
import { removeFavourite } from '@/lib/favouriteServer';
import { createServerClient } from '@/lib/supabaseServer';
import { oneOf, uuid } from '@/lib/validation';
import type { FavouriteTargetType } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TARGET_TYPES = ['service', 'professional'] as const;

/**
 * DELETE /api/favourites/:type/:id — remove a favourite (§25.4).
 *
 * Not found is not an error: removing something already gone is the desired
 * state, so the answer is `200` with `removed: 0` rather than a `404` the caller
 * would have to special-case.
 */
export async function DELETE(
  req: Request,
  { params }: { params: { type: string; id: string } }
) {
  return handle(req, 'favourites.remove', async (requestId) => {
    const { auth, customer } = await requireCustomer(req);
    const targetType = oneOf(params.type, 'type', TARGET_TYPES) as FavouriteTargetType;
    const targetId = uuid(params.id, 'id');

    const supabase = createServerClient();
    const { removed } = await removeFavourite(customer.id, targetType, targetId, supabase);

    if (removed > 0) {
      await audit(supabase, {
        actorProfileId: auth.userId,
        action: 'favourite.remove',
        entityType: 'favourites',
        metadata: { target_type: targetType, target_id: targetId },
        ipAddress: clientIp(req),
        requestId,
      });
    }

    return ok({ removed });
  });
}
