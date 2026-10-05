import { readApiError, type ApiErrorCode } from './api';
import { authorizationHeader } from './sessionHeaders';

/**
 * The browser's half of the saved-address contract (§5.2, §20.1).
 *
 * `POST /api/customers/me/addresses` was built in Phase 1 and never called from a
 * component, which left a signed-in customer with no way to save an address at
 * all — and so no way to finish a booking, because `POST /api/bookings` takes an
 * `addressId` and refuses a typed area. The gap was invisible from the tests
 * because every route test builds its own `Request` with the header already
 * attached; nothing imported the module that was missing.
 *
 * ## The `Authorization` header
 *
 * It is attached here, once, rather than left to each call site. The session
 * lives in `localStorage` — `getSupabase()` persists it there — so
 * `credentials: 'include'` carries nothing `requireCustomer` can check, and a
 * fetch that forgets the header is a 401 whose message ("Please sign in to
 * continue.") is wrong on a page the user is visibly signed in to.
 * `lib/sessionHeaders.ts` names this exact symptom as one of the two bugs that
 * produced it, so a client that imported the helper would have inherited the
 * fix; this module exists so there is one transport to import it from.
 *
 * ## Why the payload is built field by field
 *
 * `validateAddressInput` reads an allow-list, and `customer_id` is not on it —
 * ownership is the server's to decide, from the session. Assembling the body by
 * hand rather than spreading the input means a field added to `CreateAddressInput`
 * later cannot ride along to the server by accident, and it makes the three
 * fields the server spells in snake_case (`address_type`, `access_notes`,
 * `is_default`) a translation the form never has to know about.
 */

export class AddressApiError extends Error {
  constructor(
    message: string,
    readonly code: ApiErrorCode | string,
    readonly status: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AddressApiError';
  }

  /**
   * The per-field messages of a `VALIDATION_ERROR`, keyed by wire field name.
   *
   * Deliberately not renamed. `validateAddressInput` fails with the names it read
   * (`area`, `pincode`, `address_type`), and a form that has to translate them
   * before putting a message under an input is a second place for the two to
   * drift apart.
   */
  get fields(): Record<string, string> | null {
    const fields = this.details?.fields;
    return fields && typeof fields === 'object' ? (fields as Record<string, string>) : null;
  }
}

/**
 * One authenticated call.
 *
 * `authorizationHeader()` is resolved before the try for the reason
 * `lib/bookingClient.ts` gives: a missing `NEXT_PUBLIC_*` key makes `supabase`
 * throw, and inside the try that would be reported as "check your connection",
 * which is a claim about the world rather than about the build.
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const auth = await authorizationHeader();

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...auth,
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new AddressApiError(
      'We could not reach SmartHelp. Check your connection and try again.',
      'NETWORK_ERROR',
      0
    );
  }

  if (!res.ok) {
    const { message, code, details } = await readApiError(res);
    throw new AddressApiError(message, code, res.status, details);
  }

  const body = (await res.json()) as { data: T };
  return body.data;
}

// ── Types ────────────────────────────────────────────────────

/**
 * One saved address as the client receives it.
 *
 * Mirrors `AddressView` in `lib/addressServer.ts` rather than importing it: that
 * module reaches `createServerClient()`, and a browser component should not pull a
 * server module's graph in to learn a field name. The route is the authority for
 * this shape.
 */
export interface SavedAddress {
  id: string;
  label: string;
  addressType: 'home' | 'work' | 'other';
  line1: string;
  line2: string | null;
  area: string;
  city: string;
  state: string;
  pincode: string;
  lat: number;
  lng: number;
  landmark: string | null;
  accessNotes: string | null;
  isDefault: boolean;
  locality: { id: string; name: string } | null;
  /** `not_yet_available` is a real place we cannot serve yet, not a broken row. */
  coverage: 'covered' | 'not_yet_available';
  /** `12, 4th Cross, Indiranagar, Bengaluru 560038` — for the picker and the pro. */
  formatted: string;
  createdAt: string;
  updatedAt: string;
}

export interface AddressListResult {
  addresses: SavedAddress[];
  defaultAddressId: string | null;
}

export type AddressTypeInput = 'home' | 'work' | 'other';

/**
 * What a caller may ask for, mirroring `validateAddressInput` (`lib/validation.ts`).
 *
 * The five required fields are the ones the server refuses to do without. The
 * optional ones are omitted from the payload when unset rather than sent as null:
 * `optionalStr` treats `null` and `undefined` the same, and leaving a key out is
 * what makes the wire body readable in a test. There is no `customerId` — see the
 * note at the top of the file.
 */
export interface CreateAddressInput {
  line1: string;
  area: string;
  city: string;
  state: string;
  pincode: string;
  label?: string;
  addressType?: AddressTypeInput;
  line2?: string | null;
  landmark?: string | null;
  accessNotes?: string | null;
  /**
   * A point, as a pair. Both or neither: the column is `not null`, and the server
   * resolves a missing one from the locality it matches.
   */
  lat?: number;
  lng?: number;
  /**
   * Make this the default. A first address is made default by the server without
   * being asked (§5.2), so this only means anything for a later one.
   */
  isDefault?: boolean;
}

export interface CreateAddressResult {
  address: SavedAddress;
  /**
   * `locality_centre` when the server filled the coordinates in from the area
   * rather than being given them. The form shows it, because "we matched your
   * area" and "we have your exact pin" are different promises to make to somebody
   * waiting for a professional at the door.
   */
  locationPrecision: 'exact' | 'locality_centre';
}

// ── Calls ────────────────────────────────────────────────────

/** The caller's own saved addresses. Private: 401/403 means signed out. */
export function fetchAddresses(signal?: AbortSignal): Promise<AddressListResult> {
  return request<AddressListResult>('/api/customers/me/addresses', {
    ...(signal ? { signal } : {}),
  });
}

function hasPoint(
  input: CreateAddressInput
): input is CreateAddressInput & { lat: number; lng: number } {
  return (
    typeof input.lat === 'number' &&
    Number.isFinite(input.lat) &&
    typeof input.lng === 'number' &&
    Number.isFinite(input.lng)
  );
}

/**
 * A trimmed optional field, or nothing at all.
 *
 * The server trims every string before validating it, so a value of `'   '`
 * reaches the row as `''` — an empty `line2` rather than a NULL, which reads as
 * "they left a blank line in" instead of "they did not write one". Dropping it
 * here is the same value with a shape that means what it looks like.
 */
function optional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function createAddress(input: CreateAddressInput): Promise<CreateAddressResult> {
  // A half-sent point is dropped rather than forwarded. `validateAddressInput`
  // refuses one, and the server's own answer for "no coordinates" is the centre of
  // the locality it resolved — which it reports back as `locationPrecision`, so
  // the honest thing to show is "the centre of your area", not a pin we invented.
  const point = hasPoint(input) ? { lat: input.lat, lng: input.lng } : {};

  const label = optional(input.label);
  const line2 = optional(input.line2);
  const landmark = optional(input.landmark);
  const accessNotes = optional(input.accessNotes);

  return request<CreateAddressResult>('/api/customers/me/addresses', {
    method: 'POST',
    body: JSON.stringify({
      // Trimmed here so the body is what the row will hold. `validateAddressInput`
      // trims anyway; doing it once means the payload can be asserted on and the
      // pinned column cannot collect the padding.
      line1: input.line1.trim(),
      area: input.area.trim(),
      city: input.city.trim(),
      state: input.state.trim(),
      pincode: input.pincode.trim(),
      ...(label ? { label } : {}),
      ...(input.addressType ? { address_type: input.addressType } : {}),
      ...(line2 ? { line2 } : {}),
      ...(landmark ? { landmark } : {}),
      ...(accessNotes ? { access_notes: accessNotes } : {}),
      ...(input.isDefault ? { is_default: true } : {}),
      ...point,
    }),
  });
}
