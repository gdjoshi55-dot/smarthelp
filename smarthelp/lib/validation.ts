import { ApiHttpError } from './api';
import { createServerClient } from './supabaseServer';
import { can, isAdminRole, isStaffRole, type Capability } from './roles';
import type { Profile, UserRole } from './supabase';
import { DEFAULT_PHONE_COUNTRY_CODE } from './constants';

/**
 * Server-side validation and authorisation (§25.12, §26.2, §11 BUILD RULES).
 *
 * Hand-written validators, deliberately: the stack has no zod and no ORM, and
 * a route with an explicit allow-list and length cap is easier to audit than a
 * schema string. The same functions are imported by client components, so a
 * field can be checked in the form and again on the server — the server check
 * is the one that counts.
 */

// ── Field primitives ────────────────────────────────────────

export type FieldErrors = Record<string, string>;

export function fail(fields: FieldErrors, message = 'Please correct the highlighted fields'): never {
  throw new ApiHttpError('VALIDATION_ERROR', message, 400, { fields });
}

export function str(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; trim?: boolean } = {}
): string {
  if (typeof value !== 'string') fail({ [field]: 'This field is required' });
  const out = opts.trim === false ? (value as string) : (value as string).trim();
  const min = opts.min ?? 1;
  const max = opts.max ?? 255;
  if (out.length < min) fail({ [field]: `Must be at least ${min} characters` });
  if (out.length > max) fail({ [field]: `Must be ${max} characters or fewer` });
  return out;
}

export function optionalStr(
  value: unknown,
  field: string,
  opts: { max?: number } = {}
): string | null {
  if (value === undefined || value === null || value === '') return null;
  return str(value, field, { min: 0, max: opts.max ?? 500 });
}

export function int(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number } = {}
): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
    fail({ [field]: 'Enter a whole number' });
  }
  if (opts.min !== undefined && n < opts.min) {
    fail({ [field]: `Must be ${opts.min} or more` });
  }
  if (opts.max !== undefined && n > opts.max) {
    fail({ [field]: `Must be ${opts.max} or less` });
  }
  return n;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(value: unknown, field: string): string {
  const out = str(value, field, { min: 36, max: 36 });
  if (!UUID_RE.test(out)) fail({ [field]: 'This identifier is not valid' });
  return out.toLowerCase();
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Indian mobile numbers, stored in E.164 with the country code.
 *
 * The country code is part of the stored value, always. That is not
 * pedantry: `profiles.phone` is unique and the OTP ledger is keyed on this
 * string, so if a bare ten-digit number were stored as `+9876543210` then the
 * same person typing `9876543210` and typing `+91 98765 43210` would land on
 * two different accounts, with two OTP ledgers and two booking histories.
 * One canonical form per human.
 */
export function normalizePhone(value: unknown, field = 'phone'): string {
  const raw = str(value, field, { min: 10, max: 20 }).replace(/[\s\-()]/g, '');
  const cc = DEFAULT_PHONE_COUNTRY_CODE;

  let digits = raw.replace(/^\+/, '');
  // Strip the country code the user typed, if they typed one, so that both
  // `9876543210` and `+91 98765 43210` reduce to the same national number.
  if (digits.length === cc.length + 10 && digits.startsWith(cc)) {
    digits = digits.slice(cc.length);
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  if (!/^[6-9][0-9]{9}$/.test(digits)) {
    fail({ [field]: 'Enter a 10-digit mobile number' });
  }
  return `+${cc}${digits}`;
}

export function email(value: unknown, field = 'email'): string {
  const out = str(value, field, { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out)) fail({ [field]: 'Enter a valid email address' });
  return out;
}

export function oneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[]
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail({ [field]: `Must be one of: ${allowed.join(', ')}` });
  }
  return value as T;
}

// ── Auth ────────────────────────────────────────────────────

export interface AuthContext {
  userId: string;
  email: string | null;
  phone: string | null;
  role: UserRole;
  status: Profile['status'];
  profile: Profile;
  accessToken: string;
}

/**
 * Layer 2 of the three authorisation layers (§26.2). Resolves the caller from
 * the bearer token, then loads their profile so the role is the one the
 * database holds — never one the client asserted.
 */
export async function requireAuth(
  req: Request,
  roles?: UserRole[]
): Promise<AuthContext> {
  const header = req.headers.get('authorization') || '';
  const token = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : null;

  if (!token) {
    throw new ApiHttpError('UNAUTHENTICATED', 'Please sign in to continue.', 401);
  }

  const supabase = createServerClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    throw new ApiHttpError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.', 401);
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', data.user.id)
    .maybeSingle();

  if (profileError) {
    throw new ApiHttpError('INTERNAL_ERROR', 'Could not load your profile.', 500);
  }
  if (!profile) {
    throw new ApiHttpError(
      'UNAUTHENTICATED',
      'No profile exists for this login. Contact support if this is unexpected.',
      401
    );
  }
  if (profile.status === 'deleted') {
    throw new ApiHttpError('FORBIDDEN', 'This account has been deleted.', 403);
  }
  if (profile.status === 'suspended' || profile.status === 'blocked') {
    throw new ApiHttpError(
      'FORBIDDEN',
      'This account is suspended. Contact support@smarthelp.test to appeal.',
      403
    );
  }

  if (roles && roles.length > 0 && !roles.includes(profile.role)) {
    throw new ApiHttpError(
      'FORBIDDEN',
      'You do not have access to this action.',
      403,
      { required: roles, actual: profile.role }
    );
  }

  return {
    userId: profile.id,
    email: profile.email,
    phone: profile.phone,
    role: profile.role,
    status: profile.status,
    profile,
    accessToken: token,
  };
}

/** Layer 2, capability flavour: asks for a grant rather than a role. */
export async function requireCapability(
  req: Request,
  capability: Capability
): Promise<AuthContext> {
  const auth = await requireAuth(req);
  if (!can(auth.role, capability)) {
    throw new ApiHttpError('FORBIDDEN', 'You do not have permission to do this.', 403, {
      capability,
    });
  }
  return auth;
}

export function requireStaff(auth: AuthContext): AuthContext {
  if (!isStaffRole(auth.role)) {
    throw new ApiHttpError('FORBIDDEN', 'Staff access only.', 403);
  }
  return auth;
}

export function requireAdmin(auth: AuthContext): AuthContext {
  if (!isAdminRole(auth.role)) {
    throw new ApiHttpError('FORBIDDEN', 'Admin access only.', 403);
  }
  return auth;
}

// ── Request body ────────────────────────────────────────────

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiHttpError('VALIDATION_ERROR', 'Expected a JSON object body.', 400);
  }
  return body as Record<string, unknown>;
}

// ── Endpoint validators ─────────────────────────────────────

// 'signup' and 'password_reset' arrive with 0026_otp_signup_and_reset_purposes.
const OTP_PURPOSES = ['login', 'staff_login', 'admin_mfa', 'signup', 'password_reset'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export function validateSendOtp(body: Record<string, unknown>) {
  const channel = oneOf(body.channel, 'channel', ['phone', 'email'] as const);
  const purpose = oneOf(body.purpose ?? 'login', 'purpose', OTP_PURPOSES);
  const target =
    channel === 'phone' ? normalizePhone(body.phone) : email(body.email);

  return { channel, purpose, target };
}

/**
 * A delivered code, as the person would retype it. Spaces and dashes are
 * stripped because the email template groups the digits for legibility; the
 * rest must be digits, so a pasted word cannot reach the hash comparison.
 */
function otpCode(value: unknown, field = 'code'): string {
  const out = str(value, field, { min: 4, max: 8 }).replace(/[\s-]/g, '');
  if (!/^[0-9]{4,8}$/.test(out)) {
    fail({ [field]: 'Enter the code exactly as it was sent' });
  }
  return out;
}

export function validateVerifyOtp(body: Record<string, unknown>) {
  const channel = oneOf(body.channel, 'channel', ['phone', 'email'] as const);
  const purpose = oneOf(body.purpose ?? 'login', 'purpose', OTP_PURPOSES);
  const target =
    channel === 'phone' ? normalizePhone(body.phone) : email(body.email);
  const code = otpCode(body.code);

  return { channel, purpose, target, code };
}

export function validateStaffSignIn(body: Record<string, unknown>) {
  return {
    email: email(body.email),
    password: password(body.password),
  };
}

/**
 * Password policy for the email + password model.
 *
 * Eight characters with at least one letter and one digit. This is the floor
 * Supabase would accept anyway, so anything stricter would only push people
 * towards writing it on a sticky note; the strength meter on the sign-up form
 * is where the real nudge lives.
 *
 * `trim: false` is deliberate — a password is opaque bytes, and silently
 * stripping the ends of one makes "correct password rejected" a support call.
 */
export function password(value: unknown, field = 'password'): string {
  const out = str(value, field, { min: 8, max: 200, trim: false });
  if (!/[a-zA-Z]/.test(out) || !/[0-9]/.test(out)) {
    fail({ [field]: 'Use at least 8 characters, including a letter and a number' });
  }
  return out;
}

/**
 * The confirmation field is compared here as well as in the browser, so a
 * client that skips the check still cannot set a password the person did not
 * retype. The two values are never echoed into an error or a log line.
 */
function matchConfirmation(body: Record<string, unknown>, pw: string, field: string) {
  const confirm = body[field];
  if (confirm === undefined || confirm === null) return;
  if (typeof confirm !== 'string' || confirm !== pw) {
    fail({ [field]: 'The two passwords do not match' });
  }
}

const USER_ROLES_ALLOWED = ['customer', 'professional'] as const;

/** POST /api/auth/sign-in — any role, password only. */
export function validateSignIn(body: Record<string, unknown>) {
  return {
    email: email(body.email),
    password: password(body.password),
  };
}

/** POST /api/auth/sign-up/start — proves the mailbox, creates nothing. */
export function validateSignUpStart(body: Record<string, unknown>) {
  return {
    email: email(body.email),
    role: oneOf(body.role ?? 'customer', 'role', USER_ROLES_ALLOWED),
    fullName: str(body.full_name, 'full_name', { min: 2, max: 120 }),
  };
}

/**
 * POST /api/auth/sign-up/complete — the verified half of sign-up.
 *
 * The password arrives here for the first time. Nothing in this function may
 * log the body or the `password` field: `handle()` records the request id and
 * nothing else, and the audit row is written from named fields only.
 */
export function validateSignUpComplete(body: Record<string, unknown>) {
  const pw = password(body.password);
  matchConfirmation(body, pw, 'password_confirm');
  // Optional. `profiles.phone` is nullable since migration 0027, so an account
  // that leaves this blank is valid and stores NULL rather than a fabricated
  // value. A number that *is* given still has to be a real mobile number, and
  // is canonicalised here so `9876543210` and `+91 98765 43210` cannot become
  // two different accounts.
  const rawPhone = body.phone == null ? '' : String(body.phone).trim();
  return {
    email: email(body.email),
    role: oneOf(body.role ?? 'customer', 'role', USER_ROLES_ALLOWED),
    fullName: str(body.full_name, 'full_name', { min: 2, max: 120 }),
    code: otpCode(body.code),
    password: pw,
    phone: rawPhone ? normalizePhone(rawPhone, 'phone') : undefined,
  };
}

/** POST /api/auth/password-reset/start — always the same answer. */
export function validatePasswordResetStart(body: Record<string, unknown>) {
  return { email: email(body.email) };
}

/** POST /api/auth/password-reset/complete — code plus the new password. */
export function validatePasswordResetComplete(body: Record<string, unknown>) {
  const pw = password(body.password);
  matchConfirmation(body, pw, 'password_confirm');
  return {
    email: email(body.email),
    code: otpCode(body.code),
    password: pw,
  };
}

export function validateStartOtp(body: Record<string, unknown>) {
  const role = oneOf(body.role, 'role', USER_ROLES_ALLOWED);
  const phone = normalizePhone(body.phone);
  const fullName = str(body.full_name, 'full_name', { min: 2, max: 120 });
  return { role, phone, fullName };
}

const DOC_TYPES = [
  'aadhaar_front',
  'aadhaar_back',
  'pan',
  'address_proof',
  'selfie',
  'police_verification',
  'training_certificate',
  'bank_passbook',
] as const;

export function validateProfessionalApply(body: Record<string, unknown>) {
  const experienceMonths = int(body.experience_months ?? 0, 'experience_months', {
    min: 0,
    max: 600,
  });
  const serviceIds = Array.isArray(body.service_ids)
    ? (body.service_ids as unknown[]).map((v) => uuid(v, 'service_ids'))
    : fail({ service_ids: 'Pick at least one service' });

  if (serviceIds.length === 0 || serviceIds.length > 40) {
    fail({ service_ids: 'Pick between 1 and 40 services' });
  }

  return {
    experienceMonths,
    serviceIds: [...new Set(serviceIds)],
    // No `bio` here: `professionals` has no such column, so accepting one would
    // mean validating a field and then silently dropping it. A professional's
    // blurb arrives with the profile fields added in the professional phase.
    documents: (Array.isArray(body.documents) ? body.documents : []).map((d: any) => ({
      docType: oneOf(d?.doc_type, 'doc_type', DOC_TYPES),
      filePath: str(d?.file_path, 'file_path', { min: 3, max: 512 }),
    })),
  };
}

export function validateUpdateMe(body: Record<string, unknown>) {
  const patch: { full_name?: string; email?: string; avatar_url?: string; locale?: string } = {};
  if (body.full_name !== undefined) patch.full_name = str(body.full_name, 'full_name', { min: 2, max: 120 });
  if (body.email !== undefined) patch.email = body.email === null ? '' : email(body.email);
  if (body.avatar_url !== undefined) patch.avatar_url = str(body.avatar_url, 'avatar_url', { max: 1024 });
  if (body.locale !== undefined) {
    patch.locale = oneOf(body.locale, 'locale', ['en-IN', 'hi-IN', 'ta-IN', 'te-IN', 'ml-IN', 'kn-IN', 'mr-IN'] as const);
  }
  if (Object.keys(patch).length === 0) {
    fail({}, 'Nothing to update');
  }
  return patch;
}

/** Pagination, capped so a client cannot ask for the whole table. */
export function parsePaging(url: URL, defaultLimit = 25, maxLimit = 100) {
  const limit = Math.min(
    maxLimit,
    Math.max(1, Number(url.searchParams.get('limit') ?? defaultLimit) || defaultLimit)
  );
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
  return { limit, offset };
}

// ── Coordinates, dates, addresses (Phase 1) ─────────────────

/** A coordinate, as a decimal — the columns are `numeric(9,6)`. */
export function num(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number } = {}
): number {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    fail({ [field]: 'Enter a number' });
  }
  if (opts.min !== undefined && n < opts.min) fail({ [field]: `Must be ${opts.min} or more` });
  if (opts.max !== undefined && n > opts.max) fail({ [field]: `Must be ${opts.max} or less` });
  return n;
}

export function latitude(value: unknown, field = 'lat'): number {
  return num(value, field, { min: -90, max: 90 });
}

export function longitude(value: unknown, field = 'lng'): number {
  return num(value, field, { min: -180, max: 180 });
}

export function pincode(value: unknown, field = 'pincode'): string {
  const out = str(value, field, { min: 6, max: 6 });
  if (!/^[0-9]{6}$/.test(out)) fail({ [field]: 'Enter a six-digit pincode' });
  return out;
}

const ADDRESS_TYPES = ['home', 'work', 'other'] as const;
export type AddressTypeInput = (typeof ADDRESS_TYPES)[number];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar date, and never one in the past.
 *
 * `Date.parse('2026-02-31')` is a real date in some engines and not in others,
 * so the parts are checked and the date is round-tripped rather than trusted. A
 * past date is refused here rather than answered with an empty slot list,
 * because an empty list reads as "fully booked" and "in the past" reads as a
 * mistake the person made.
 */
export function calendarDate(value: unknown, field = 'date', today = new Date()): string {
  const out = str(value, field, { min: 10, max: 10 });
  if (!ISO_DATE_RE.test(out)) fail({ [field]: 'Use the format YYYY-MM-DD' });

  const [y, m, d] = out.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    fail({ [field]: 'That date does not exist' });
  }

  const startOfToday = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );
  if (parsed.getTime() < startOfToday.getTime()) {
    fail({ [field]: 'Choose today or a later date' });
  }

  return out;
}

export interface AddressInput {
  label: string;
  addressType: AddressTypeInput;
  line1: string;
  line2: string | null;
  area: string;
  city: string;
  state: string;
  pincode: string;
  lat?: number;
  lng?: number;
  landmark: string | null;
  accessNotes: string | null;
  isDefault?: boolean;
}

/**
 * POST /api/customers/me/addresses — the §5.2 field list, and nothing else.
 *
 * `customer_id` is not in the allow-list and cannot be reached from a payload;
 * the caller is the owner. `lat`/`lng` are optional here even though the column
 * is `not null`: someone who declines the browser's location prompt and types an
 * area has no coordinates to give. The server then fills them from the resolved
 * locality centre and answers `locationPrecision: 'locality_centre'`, so the
 * form can say so instead of pretending the pin is exact.
 */
export function validateAddressInput(body: Record<string, unknown>): AddressInput {
  const hasLat = body.lat !== undefined && body.lat !== null && body.lat !== '';
  const hasLng = body.lng !== undefined && body.lng !== null && body.lng !== '';
  if (hasLat !== hasLng) {
    fail({ [hasLat ? 'lng' : 'lat']: 'Give both coordinates, or neither' });
  }

  const input: AddressInput = {
    label: body.label === undefined ? 'Home' : str(body.label, 'label', { min: 1, max: 40 }),
    addressType: oneOf(body.address_type ?? 'home', 'address_type', ADDRESS_TYPES),
    line1: str(body.line1, 'line1', { min: 1, max: 200 }),
    line2: optionalStr(body.line2, 'line2', { max: 200 }),
    area: str(body.area, 'area', { min: 2, max: 120 }),
    city: str(body.city, 'city', { min: 2, max: 120 }),
    state: str(body.state, 'state', { min: 2, max: 120 }),
    pincode: pincode(body.pincode),
    landmark: optionalStr(body.landmark, 'landmark', { max: 160 }),
    accessNotes: optionalStr(body.access_notes, 'access_notes', { max: 500 }),
  };

  if (hasLat) {
    input.lat = latitude(body.lat);
    input.lng = longitude(body.lng);
  }
  if (body.is_default !== undefined) {
    input.isDefault = body.is_default === true || body.is_default === 'true';
  }

  return input;
}

/** PUT /api/customers/me/addresses/[id] — a subset, and at least one field. */
export function validateAddressPatch(body: Record<string, unknown>): Partial<AddressInput> {
  const hasLat = body.lat !== undefined && body.lat !== null && body.lat !== '';
  const hasLng = body.lng !== undefined && body.lng !== null && body.lng !== '';
  if (hasLat !== hasLng) {
    fail({ [hasLat ? 'lng' : 'lat']: 'Give both coordinates, or neither' });
  }

  const patch: Record<string, unknown> = {};
  if (body.label !== undefined) patch.label = str(body.label, 'label', { min: 1, max: 40 });
  if (body.address_type !== undefined) {
    patch.addressType = oneOf(body.address_type, 'address_type', ADDRESS_TYPES);
  }
  if (body.line1 !== undefined) patch.line1 = str(body.line1, 'line1', { min: 1, max: 200 });
  if (body.line2 !== undefined) patch.line2 = optionalStr(body.line2, 'line2', { max: 200 });
  if (body.area !== undefined) patch.area = str(body.area, 'area', { min: 2, max: 120 });
  if (body.city !== undefined) patch.city = str(body.city, 'city', { min: 2, max: 120 });
  if (body.state !== undefined) patch.state = str(body.state, 'state', { min: 2, max: 120 });
  if (body.pincode !== undefined) patch.pincode = pincode(body.pincode);
  if (hasLat) {
    patch.lat = latitude(body.lat);
    patch.lng = longitude(body.lng);
  }
  if (body.landmark !== undefined) {
    patch.landmark = optionalStr(body.landmark, 'landmark', { max: 160 });
  }
  if (body.access_notes !== undefined) {
    patch.accessNotes = optionalStr(body.access_notes, 'access_notes', { max: 500 });
  }
  if (body.is_default !== undefined) {
    patch.isDefault = body.is_default === true || body.is_default === 'true';
  }

  if (Object.keys(patch).length === 0) fail({}, 'Nothing to update');
  return patch as Partial<AddressInput>;
}

export interface LocationQuery {
  addressId?: string;
  lat?: number;
  lng?: number;
  area?: string;
  city?: string;
}

/**
 * The location a request is asking about, in whichever of the four forms it
 * arrived.
 *
 * An `addressId` names a private row, so the caller must prove ownership before
 * it is honoured. That is the route's job — which is why it comes back here as
 * a plain value and is checked there.
 */
export function parseLocationQuery(
  url: URL,
  opts: { required: boolean } = { required: false }
): LocationQuery {
  const p = url.searchParams;

  const hasLat = p.get('lat') !== null && p.get('lat') !== '';
  const hasLng = p.get('lng') !== null && p.get('lng') !== '';
  if (hasLat !== hasLng) {
    fail({ [hasLat ? 'lng' : 'lat']: 'Give both coordinates, or neither' });
  }

  const location: LocationQuery = {
    addressId: p.get('addressId') ? uuid(p.get('addressId'), 'addressId') : undefined,
    lat: hasLat ? latitude(p.get('lat')) : undefined,
    lng: hasLng ? longitude(p.get('lng')) : undefined,
    area: p.get('area') ? str(p.get('area'), 'area', { min: 2, max: 120 }) : undefined,
    city: p.get('city') ? str(p.get('city'), 'city', { min: 2, max: 120 }) : undefined,
  };

  const empty = !location.addressId && location.lat === undefined && !location.area;
  if (empty && opts.required) {
    fail(
      { location: 'Pass addressId, or lat and lng, or area' },
      'We need a location to check availability'
    );
  }

  return location;
}

export interface AvailabilityQuery {
  serviceId: string;
  date?: string;
  duration?: number;
  professionalId?: string;
  location: LocationQuery;
}

/** GET /api/availability — the parameter list from §27.4. */
export function parseAvailabilityQuery(url: URL, today = new Date()): AvailabilityQuery {
  const p = url.searchParams;
  const durationRaw = p.get('duration');

  return {
    serviceId: uuid(p.get('serviceId'), 'serviceId'),
    date: p.get('date') ? calendarDate(p.get('date'), 'date', today) : undefined,
    duration:
      durationRaw !== null && durationRaw !== ''
        ? int(durationRaw, 'duration', { min: 15, max: 720 })
        : undefined,
    professionalId: p.get('professionalId')
      ? uuid(p.get('professionalId'), 'professionalId')
      : undefined,
    location: parseLocationQuery(url, { required: true }),
  };
}

/** GET /api/services — the catalogue's own filter set. */
export function parseCatalogueQuery(url: URL) {
  const p = url.searchParams;
  const availableOnlyRaw = p.get('availableOnly');
  return {
    q: p.get('q') ? str(p.get('q'), 'q', { min: 1, max: 80 }) : undefined,
    category: p.get('category')
      ? str(p.get('category'), 'category', { min: 1, max: 80 })
      : undefined,
    availableOnly:
      availableOnlyRaw === null || availableOnlyRaw === ''
        ? undefined
        : availableOnlyRaw === 'true' || availableOnlyRaw === '1',
    location: parseLocationQuery(url),
  };
}
