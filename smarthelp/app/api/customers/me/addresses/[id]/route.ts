import { handle, ok } from '@/lib/api';
import { validateAddressPatch } from '@/lib/validation';
import { createServerClient } from '@/lib/supabaseServer';
import { ApiHttpError } from '@/lib/api';
import {
  addressContext,
  auditAddress,
  loadOwnedAddress,
  requireCustomer,
  resolveLocationForSave,
  toAddressView,
} from '@/lib/addressServer';
import { describeLocation } from '@/lib/catalogueServer';
import type { Address, AddressType, TablesUpdate } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLUMNS =
  'id, customer_id, address_type, label, line1, line2, area, city, state, pincode, lat, lng, landmark, access_notes, is_default, locality_id, location_precision, created_at, updated_at';

/**
 * PUT /api/customers/me/addresses/[id] — edit a saved place.
 *
 * The locality is recomputed whenever the patch could have moved the address —
 * a new `area`, `city`, or coordinates. Recomputing it only for `area` would
 * leave somebody who fixes a dropped pin still attached to the old locality and
 * therefore to the old service areas.
 *
 * `is_default` is deliberately *not* honoured through a plain update: see the
 * comment on the default route. A patch that says `is_default: false` on the
 * current default is refused rather than silently ignored, because leaving them
 * with no default after they asked to remove one is worse.
 */
export async function PUT(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'customers.addresses.update', async (requestId) => {
    const { auth, customer } = await requireCustomer(req);
    const supabase = createServerClient();

    const before = await loadOwnedAddress(customer.id, params.id);
    const patch = validateAddressPatch(await readBody(req));

    if (patch.isDefault === false && before.is_default) {
      throw new ApiHttpError(
        'INVALID_STATE',
        'Your default address cannot be unset. Make another address the default first.',
        409
      );
    }

    const update: TablesUpdate<'addresses'> = {};
    if (patch.label !== undefined) update.label = patch.label;
    if (patch.addressType !== undefined) update.address_type = patch.addressType as AddressType;
    if (patch.line1 !== undefined) update.line1 = patch.line1;
    if (patch.line2 !== undefined) update.line2 = patch.line2;
    if (patch.area !== undefined) update.area = patch.area;
    if (patch.city !== undefined) update.city = patch.city;
    if (patch.state !== undefined) update.state = patch.state;
    if (patch.pincode !== undefined) update.pincode = patch.pincode;
    if (patch.landmark !== undefined) update.landmark = patch.landmark;
    if (patch.accessNotes !== undefined) update.access_notes = patch.accessNotes;

    // The patch may have moved the address. A pin in the payload is
    // authoritative; a changed area is resolved by name, because the stored pin
    // belongs to the *old* area and carrying it across would leave the address
    // attached to the locality it just moved out of.
    const moved =
      patch.area !== undefined || patch.city !== undefined || patch.lat !== undefined;
    let located = null;
    if (moved) {
      located = await resolveLocationForSave({
        area: patch.area ?? before.area,
        city: patch.city ?? before.city,
        lat: patch.lat,
        lng: patch.lng,
      });
      update.lat = located.lat;
      update.lng = located.lng;
      update.locality_id = located.localityId;
      update.location_precision = located.precision;
    }

    const { data: updated, error } = await supabase
      .from('addresses')
      .update(update)
      .eq('id', before.id)
      .eq('customer_id', customer.id)
      .select(COLUMNS)
      .single();

    if (error) throw error;
    const row = updated as Address;

    if (patch.isDefault === true) {
      const { error: defaultError } = await supabase.rpc('set_default_address', {
        p_customer_id: customer.id,
        p_address_id: row.id,
      });
      if (defaultError) throw defaultError;
    }

    await auditAddress(req, {
      actorProfileId: auth.userId,
      requestId,
      action: 'address.updated',
      entityId: row.id,
      before: before as unknown as Record<string, unknown>,
      after: row as unknown as Record<string, unknown>,
    });

    const context = await addressContext([row]);
    return ok({
      address: toAddressView(
        row,
        located?.resolution.locality?.name ?? null,
        context.covered.has(row.locality_id ?? '')
      ),
      location: located ? describeLocation(located.resolution) : undefined,
      locationPrecision: located?.precision,
    });
  });
}

/**
 * DELETE /api/customers/me/addresses/[id] — forget a place.
 *
 * The Phase 0 schema has no `bookings.address_id` yet, so there is nothing to
 * be in use *by*. The moment Phase 2 adds that column this becomes a 409
 * ADDRESS_IN_USE when a booking references the row, instead of a delete that
 * would break a past visit. The deferral is recorded in `0008_addresses.sql`.
 */
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'customers.addresses.delete', async (requestId) => {
    const { auth, customer } = await requireCustomer(req);
    const supabase = createServerClient();

    const before = await loadOwnedAddress(customer.id, params.id);

    const { error } = await supabase
      .from('addresses')
      .delete()
      .eq('id', before.id)
      .eq('customer_id', customer.id);
    if (error) throw error;

    if (before.is_default) {
      // The partial unique index does not require *a* default, but leaving the
      // customer with none and several remaining would make the next booking
      // ambiguous, so the oldest survivor is promoted.
      const { data: next, error: nextError } = await supabase
        .from('addresses')
        .select('id')
        .eq('customer_id', customer.id)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (nextError) throw nextError;

      if (next) {
        const { error: promoteError } = await supabase.rpc('set_default_address', {
          p_customer_id: customer.id,
          p_address_id: next.id,
        });
        if (promoteError) throw promoteError;
      }
    }

    await auditAddress(req, {
      actorProfileId: auth.userId,
      requestId,
      action: 'address.deleted',
      entityId: before.id,
      before: before as unknown as Record<string, unknown>,
    });

    return ok({ deleted: true, id: before.id });
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
