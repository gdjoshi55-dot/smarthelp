/**
 * App-wide constants (§23 lib/constants.ts).
 *
 * Anything that a business can change lives in a database row, not here.
 * What belongs here is structural: route paths, slot granularity, and the
 * defaults a brand-new database is seeded with.
 */

export const APP_NAME = 'SmartHelp';
export const APP_TAGLINE = 'Trusted help. Right when you need it.';
export const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'INR';
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/**
 * Default dialling code for phone normalisation.
 *
 * A constant only in the sense of a default: it is env-overridable because
 * "no hard-coded geography in code" is a stated non-goal, and the value a
 * real deployment wants is a deployment decision. What is *not* negotiable is
 * that a number is stored with its country code — see `normalizePhone`.
 */
export const DEFAULT_PHONE_COUNTRY_CODE = process.env.DEFAULT_PHONE_COUNTRY_CODE || '91';

/** Slot granularity. A slot start is always a multiple of this, in minutes. */
export const SLOT_GRANULARITY_MIN = 30;

/** The public-facing shells. */
export const ROUTES = {
  home: '/',
  login: '/login',
  join: '/join',
  services: '/services',
  serviceDetail: (slug: string) => `/services/${slug}`,
  customer: {
    root: '/customer',
    services: '/customer/services',
    serviceDetail: (slug: string) => `/customer/services/${slug}`,
    checkout: '/customer/checkout',
    bookings: '/customer/bookings',
    booking: (id: string) => `/customer/bookings/${id}`,
    wallet: '/customer/wallet',
    support: '/customer/support',
    favourites: '/customer/favourites',
    profile: '/customer/profile',
  },
  professional: {
    root: '/professional',
    jobs: '/professional/jobs',
    job: (id: string) => `/professional/jobs/${id}`,
    earnings: '/professional/earnings',
    kyc: '/professional/kyc',
    availability: '/professional/availability',
    training: '/professional/training',
    profile: '/professional/profile',
  },
  admin: {
    root: '/admin',
    bookings: '/admin/bookings',
    booking: (id: string) => `/admin/bookings/${id}`,
    professionals: '/admin/professionals',
    customers: '/admin/customers',
    services: '/admin/services',
    pricing: '/admin/pricing',
    payments: '/admin/payments',
    coupons: '/admin/coupons',
    disputes: '/admin/disputes',
    support: '/admin/support',
    analytics: '/admin/analytics',
    notifications: '/admin/notifications',
    settings: '/admin/settings',
    audit: '/admin/audit',
  },
  legal: {
    privacy: '/legal/privacy',
    terms: '/legal/terms',
    refund: '/legal/refund',
    cancellation: '/legal/cancellation',
    safety: '/legal/safety',
  },
} as const;

/**
 * The defaults written to platform_settings on first run (§31.3). They are
 * seeded as rows so an admin can change them without a deploy; these values are
 * only the initial state.
 *
 * They are seed values, not rules: `platform_settings` is a Phase 6 table, so
 * until it lands the engine reads from here. The platform fee is a *pair*
 * because §7.1 computes it as `max(fee_min, subtotal × fee_pct)` and a single
 * ambiguous `platformFee` cannot express that — 20 as a floor on a ₹437.80
 * subtotal and 20 as a percentage of one are different numbers.
 */
export const PLATFORM_DEFAULTS = {
  currency: DEFAULT_CURRENCY,
  taxRate: Number(process.env.DEFAULT_TAX_RATE || 0.18),
  commissionPct: Number(process.env.DEFAULT_COMMISSION_PCT || 0.2),
  /** A rate, not a percent: 0.04 is four per cent. */
  platformFeePct: Number(process.env.DEFAULT_PLATFORM_FEE_PCT || 0.04),
  /** The floor, in rupees — the unit every other money constant here is in. */
  platformFeeMin: Number(process.env.DEFAULT_PLATFORM_FEE_MIN || 20),
  serviceOtpLength: Number(process.env.DEFAULT_SERVICE_OTP_LENGTH || 4),
  instantLeadMinutes: Number(process.env.DEFAULT_INSTANT_LEAD_MINUTES || 30),
  /** §6.4. Longer than this and it is two jobs or a recurring booking. */
  maxBookingMinutes: Number(process.env.DEFAULT_MAX_BOOKING_MINUTES || 480),
  /** §6.2. How far ahead a booking may be scheduled. */
  maxSchedulingDaysAhead: Number(process.env.DEFAULT_MAX_SCHEDULING_DAYS || 30),
  /** §6.1. What "as soon as possible" promises before it starts escalating. */
  instantMatchTargetSeconds: Number(process.env.DEFAULT_INSTANT_MATCH_TARGET_SECONDS || 120),
  /** §7.3 / §11.2. After this, the arrival is late. */
  lateArrivalThresholdMin: Number(process.env.DEFAULT_LATE_ARRIVAL_THRESHOLD_MIN || 15),
  /** §11.2. After this with no OTP, the job may be marked a no-show. */
  noShowAfterMin: Number(process.env.DEFAULT_NO_SHOW_AFTER_MIN || 45),
  /**
   * §12.3. At or below this, a support agent may request a refund that is
   * executed immediately; above it the request is created and left `requested`
   * for an approver.
   *
   * Rupees, like every other money figure here — `lib/money.ts` converts at the
   * boundary. The environment variable is a **fallback**, not the source of
   * truth: `platform_settings` is a Phase 6 table, so until it lands the rule
   * reads from here. The exact pattern Phase 1 used for `instant_lead_minutes`
   * and Phase 2 for `maxBookingMinutes`.
   */
  supportRefundLimit: Number(process.env.DEFAULT_SUPPORT_REFUND_LIMIT || 1500),

  // ── Phase 4: the professional app ──────────────────────────────
  //
  // Offered jobs, the service OTP's own policy, and the arrive geofence.
  // All of these are Phase 6 `platform_settings` rows eventually; until that
  // table lands they read from here, the same pattern Phase 1 used for
  // `instant_lead_minutes`.

  /**
   * §9.4. How long an offer is live before lazy expiry. Phase 5's sweeper cron
   * expires offers eagerly; until it exists the inbox read and the accept route
   * refuse an offer past this (D1, Pitfall 6).
   */
  offerTtlMinutes: Number(process.env.DEFAULT_OFFER_TTL_MINUTES || 15),
  /**
   * §22.3. The service OTP's TTL, attempt cap, lockout and regeneration cap.
   * `serviceOtpLength` above is the digit count; these are the rest of the
   * policy. Distinct from the sign-in OTP policy (`OTP_*` below) because the
   * two are different secrets with different lifetimes.
   */
  otpTtlMinutes: Number(process.env.DEFAULT_OTP_TTL_MINUTES || 10),
  otpMaxAttempts: Number(process.env.DEFAULT_OTP_MAX_ATTEMPTS || 3),
  otpLockoutMinutes: Number(process.env.DEFAULT_OTP_LOCKOUT_MINUTES || 15),
  otpMaxGenerations: Number(process.env.DEFAULT_OTP_MAX_GENERATIONS || 3),
  /**
   * §14.3 / §25.7 (D7). The geofence radius, in metres: the server-side
   * haversine check an arrive must pass, or be overridden with a reason.
   */
  defaultArrivalRadiusM: Number(process.env.DEFAULT_ARRIVAL_RADIUS_M || 100),
  /**
   * §10.2 (D6). How old a professional's last location ping may be before the
   * track payload treats it as unknown and answers `proLocation: null`. A stale
   * pin is worse than no pin: a customer watching it move would be watching a
   * building the professional left minutes ago. No ETA is ever derived from it.
   */
  proLocationFreshMinutes: Number(process.env.DEFAULT_PRO_LOCATION_FRESH_MINUTES || 15),
  /**
   * §25.7 (D6). The `POST /api/professionals/me/location` throttle: a ping that
   * arrives within this many seconds of the last accepted one is dropped rather
   * than written. One write per client per window, computed from
   * `location_updated_at` — no separate rate-limit table exists.
   */
  proLocationThrottleSeconds: Number(process.env.DEFAULT_PRO_LOCATION_THROTTLE_SECONDS || 30),
} as const;

/**
 * The KYC documents the professional stepper collects (§20.10).
 *
 * These are exactly the `professional_documents.doc_type` values the `0005`
 * check constraint accepts for the three steps (Identity / Address / Selfie),
 * and the same set the `kyc_document_decision` roll-up (0029) counts over —
 * one list, three readers. `address_proof` and `selfie` are self-describing;
 * Identity is an Aadhaar front. The wider enum (`aadhaar_back`, `pan`,
 * `police_verification`, …) stays available for Phase 6 to request.
 */
export const KYC_REQUIRED_DOC_TYPES = [
  'aadhaar_front',
  'address_proof',
  'selfie',
] as const;

export type KycDocType = (typeof KYC_REQUIRED_DOC_TYPES)[number];

/**
 * The KYC upload policy (§24.15), mirroring the `kyc-documents` bucket row in
 * `0000_storage_buckets.sql`.
 *
 * These are declared *and* enforced at the route, but the signature that
 * matters is the bucket's own `allowed_mime_types` / `file_size_limit` — a
 * signed URL cannot promise a byte count, so the route check is a courtesy
 * refusal with a readable message, and the bucket is the backstop. The client
 * pre-checks the same two numbers before it ever uploads.
 */
export const KYC_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const KYC_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

/** Default duration ladder offered when an admin has not overridden it (§4.3). */
export const DEFAULT_DURATION_LADDER = [30, 45, 60, 90, 120, 180, 240, 300, 360];
export const DEFAULT_EXTENSION_OPTIONS = [30, 60, 90];

/**
 * Sign-in OTP policy (§26.1).
 *
 * These live here, not in `lib/otp.ts`, because both sides need them: the
 * login screen renders exactly `OTP_LENGTH` input slots, and the server issues
 * the code. Importing them from `lib/otp.ts` would pull `nodemailer` and the
 * service-role client into the browser bundle — this module imports nothing.
 */
export const OTP_LENGTH = 6;
export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 3;
export const OTP_RESEND_SECONDS = 60;
export const OTP_LOCKOUT_MINUTES = 15;
