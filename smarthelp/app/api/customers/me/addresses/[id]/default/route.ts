import { handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import {
  addressContext,
  auditAddress,
  loadOwnedAddress,
  requireCustomer,
  toAddressView,
} from '@/lib/addressServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLUMNS =
  'id, customer_id, address_type, label, line1, line2, area, city, state, pincode, lat, lng, landmark, access_notes, is_default, locality_id, location_precision, created_at, updated_at';

/**
 * POST /api/customers/me/addresses/[id]/default — make this the default.
 *
 * The whole switch is one RPC, `set_default_address`, because "clear the old
 * one, then set the new one" as two statements from a request handler can
 * interleave with a second request and leave the customer with no default at
 * all. The RPC is also the only writer, so the partial unique index behind the
 * invariant never sees a second default.
 *
 * The ownership check is repeated here even though the RPC checks it too: the
 * RPC's check exists to make the function safe to call directly, and a route
 * that skipped its own check would answer 200 for somebody else's address id
 * with a row the caller then cannot read anyway.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'customers.addresses.setDefault', async (requestId) => {
    const { auth, customer } = await requireCustomer(req);
    const supabase = createServerClient();

    const before = await loadOwnedAddress(customer.id, params.id);

    const { error } = await supabase.rpc('set_default_address', {
      p_customer_id: customer.id,
      p_address_id: before.id,
    });
    if (error) throw error;

    const { data, error: readError } = await supabase
      .from('addresses')
      .select(COLUMNS)
      .eq('id', before.id)
      .single();
    if (readError) throw readError;

    await auditAddress(req, {
      actorProfileId: auth.userId,
      requestId,
      action: 'address.set_default',
      entityId: before.id,
      before: { is_default: before.is_default },
      after: { is_default: true },
    });

    const context = await addressContext([data]);
    return ok({
      address: toAddressView(
        data,
        context.names.get(data.locality_id ?? '') ?? null,
        context.covered.has(data.locality_id ?? '')
      ),
    });
  });
}
