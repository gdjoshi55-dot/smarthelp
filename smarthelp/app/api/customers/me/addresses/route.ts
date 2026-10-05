import { created, handle, ok } from '@/lib/api';
import { validateAddressInput } from '@/lib/validation';
import { createServerClient } from '@/lib/supabaseServer';
import {
  addressContext,
  auditAddress,
  requireCustomer,
  resolveLocationForSave,
  toAddressView,
} from '@/lib/addressServer';
import { describeLocation } from '@/lib/catalogueServer';
import type { Address, AddressType } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLUMNS =
  'id, customer_id, address_type, label, line1, line2, area, city, state, pincode, lat, lng, landmark, access_notes, is_default, locality_id, location_precision, created_at, updated_at';

/**
 * GET /api/customers/me/addresses — "your saved places" (§20.1), the tab on the
 * customer's Home page.
 *
 * Private: `requireCustomer` resolves the caller through their own profile, and
 * every row read here is filtered to that `customer_id`. RLS would enforce the
 * same thing for a `authenticated` session; the service-role client is used so
 * the ownership rule lives in one place, in the query.
 */
export async function GET(req: Request) {
  return handle(req, 'customers.addresses.list', async () => {
    const { customer } = await requireCustomer(req);
    const supabase = createServerClient();

    const { data, error } = await supabase
      .from('addresses')
      .select(COLUMNS)
      .eq('customer_id', customer.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });

    if (error) throw error;

    const rows = (data ?? []) as Address[];
    const context = await addressContext(rows);

    return ok({
      addresses: rows.map((row) =>
        toAddressView(
          row,
          context.names.get(row.locality_id ?? '') ?? null,
          context.covered.has(row.locality_id ?? '')
        )
      ),
      defaultAddressId: rows.find((r) => r.is_default)?.id ?? null,
    });
  });
}

/**
 * POST /api/customers/me/addresses — save a place.
 *
 * The two interesting decisions:
 *
 *   `is_default` — §5.2 says the first address is the default without being
 *   asked. Later, an explicit `is_default: true` is honoured through the
 *   `set_default_address` RPC, which clears the previous holder in the same
 *   transaction. The row is therefore only *born* default when it is the first
 *   one: inserting `is_default: true` while another row already holds it would
 *   trip the unique partial index and fail the insert, so the switch has to
 *   happen after the row exists.
 *
 *   `locality_id` — resolved from the coordinates, the area, or the locality
 *   centre when neither was given. An address the server cannot place is refused
 *   rather than stored: `lat`/`lng` are `not null`, and a guessed point is how a
 *   professional ends up at the wrong building. `coverage: 'not_yet_available'`
 *   still appears, for a row whose locality exists but is not one we serve yet.
 */
export async function POST(req: Request) {
  return handle(req, 'customers.addresses.create', async (requestId) => {
    const { auth, customer } = await requireCustomer(req);
    const supabase = createServerClient();

    const input = validateAddressInput(await readBody(req));
    const located = await resolveLocationForSave(input);

    const { data: existing, error: countError } = await supabase
      .from('addresses')
      .select('id')
      .eq('customer_id', customer.id)
      .limit(1);
    if (countError) throw countError;

    const isFirst = (existing ?? []).length === 0;
    const wantsDefault = input.isDefault === true || isFirst;

    const { data: inserted, error } = await supabase
      .from('addresses')
      .insert({
        customer_id: customer.id,
        address_type: input.addressType as AddressType,
        label: input.label,
        line1: input.line1,
        line2: input.line2,
        area: input.area,
        city: input.city,
        state: input.state,
        pincode: input.pincode,
        lat: located.lat,
        lng: located.lng,
        landmark: input.landmark,
        access_notes: input.accessNotes,
        locality_id: located.localityId,
        location_precision: located.precision,
        // Only a first address is born default. An explicit switch waits for the
        // RPC, which is a transaction over every row the customer owns.
        is_default: isFirst,
      })
      .select(COLUMNS)
      .single();

    if (error) throw error;
    const row = inserted as Address;

    if (wantsDefault && !isFirst) {
      const { error: defaultError } = await supabase.rpc('set_default_address', {
        p_customer_id: customer.id,
        p_address_id: row.id,
      });
      if (defaultError) throw defaultError;
    }

    await auditAddress(req, {
      actorProfileId: auth.userId,
      requestId,
      action: isFirst ? 'address.created_default' : 'address.created',
      entityId: row.id,
      after: row as unknown as Record<string, unknown>,
    });

    const context = await addressContext([row]);
    return created({
      address: toAddressView(
        row,
        located.resolution.locality?.name ?? null,
        context.covered.has(row.locality_id ?? '')
      ),
      location: describeLocation(located.resolution),
      locationPrecision: located.precision,
    });
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
