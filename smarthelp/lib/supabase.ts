import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Which of the two browser keys are absent.
 *
 * Every lookup here is written as a literal `process.env.NEXT_PUBLIC_*` member
 * access, and that is load-bearing. Next.js inlines those values into the
 * browser bundle at build time, but only when it can see the literal name. A
 * computed `process.env[key]` compiles to a lookup on the `{}` that stands in
 * for `process.env` in the browser, so it reads as *undefined for every key*
 * no matter what `.env.local` says — and the app then reports missing
 * credentials with a perfectly valid environment file.
 *
 * The server does not have this problem, which is why such a check can sit
 * green through `next build` and the whole test suite and still break on the
 * first page load. `test/env-inlining.test.ts` guards the pattern.
 */
const missingEnv = [
  process.env.NEXT_PUBLIC_SUPABASE_URL ? null : 'NEXT_PUBLIC_SUPABASE_URL',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? null : 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
].filter((key): key is string => key !== null);

/**
 * The browser client. It only ever carries the anon key, so every query it
 * makes is subject to RLS — that is the point. Any route that needs to read
 * or write a row the caller must not see uses lib/supabaseServer.ts instead.
 *
 * Built lazily, behind a Proxy, for one reason: `createClient` throws when the
 * URL is missing, and a throw at module scope takes down the prerender of
 * every page that transitively imports this file — including the build itself.
 * A missing key should surface as one clear message at the moment a caller
 * actually asks for a query, not as a wall of unrelated build errors.
 */
let client: SupabaseClient<Database> | null = null;

/**
 * Whether the browser client can be built at all.
 *
 * The UI asks this before it touches `supabase`, so that a missing key becomes
 * a screen with instructions rather than a thrown error. `getSupabase()` still
 * throws, because a server route that reaches it without credentials has a real
 * fault and should fail loudly.
 */
export function supabaseConfigError(): string | null {
  if (!missingEnv.length) return null;
  return (
    `Supabase browser credentials missing: ${missingEnv.join(', ')}. ` +
    'Copy .env.example to .env.local and fill it in, then restart the dev server.'
  );
}

export function getSupabase(): SupabaseClient<Database> {
  if (client) return client;

  const problem = supabaseConfigError();
  if (problem) throw new Error(problem);

  client = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        fetch: (input: any, init?: any) => fetch(input, { ...init, cache: 'no-store' }),
      },
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    }
  );
  return client;
}

/**
 * `supabase.auth.getSession()` reads naturally, and a Proxy keeps every call
 * site unchanged while deferring construction to first use.
 */
export const supabase = new Proxy({} as SupabaseClient<Database>, {
  get(_target, prop, receiver) {
    return Reflect.get(getSupabase(), prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(getSupabase(), prop);
  },
});

export type UserRole =
  | 'customer'
  | 'professional'
  | 'admin'
  | 'support'
  | 'ops'
  | 'super_admin';

export type UserStatus =
  | 'active'
  | 'suspended'
  | 'blocked'
  | 'deleted'
  | 'pending_verification';

export type VerificationStatus =
  | 'not_submitted'
  | 'submitted'
  | 'in_review'
  | 'verified'
  | 'rejected'
  | 'expired';

export type TrainingStatus = 'not_started' | 'in_progress' | 'completed';
export type AvailabilityStatus = 'offline' | 'online' | 'busy' | 'break';
export type PricingType = 'hourly' | 'flat' | 'per_unit';
export type AddressType = 'home' | 'work' | 'other';
/** Whether `lat`/`lng` came from the browser or from the locality's centre. */
export type LocationPrecision = 'exact' | 'locality_centre';
export type OtpChannel = 'phone' | 'email';
export type OtpPurpose = 'login' | 'staff_login' | 'admin_mfa' | 'signup' | 'password_reset';

export type OtpOutcome = 'ok' | 'invalid' | 'expired' | 'locked' | 'missing';

// 0009. The whole enum ships in Phase 2 even though the code reaches four of
// its labels: adding one later is an `ALTER TYPE` that rewrites `bookings` under
// an ACCESS EXCLUSIVE lock. See the migration header for the full argument.
export type BookingType = 'instant' | 'scheduled' | 'recurring';

export type BookingStatus =
  | 'draft'
  | 'payment_pending'
  | 'paid'
  | 'searching'
  | 'assigned'
  | 'accepted'
  | 'on_the_way'
  | 'arrived'
  | 'otp_verified'
  | 'in_progress'
  | 'extension_requested'
  | 'completed'
  | 'cancelled'
  | 'refund_pending'
  | 'refunded'
  | 'disputed'
  | 'no_show'
  | 'closed';

export type DiscountType = 'percentage' | 'fixed';
export type PaymentPurpose = 'booking' | 'extension' | 'wallet_topup' | 'penalty';
export type ScheduleStatus = 'reserved' | 'in_progress' | 'completed' | 'released';

// 0014. The six states of §12.1. `partially_refunded` ships with the table for
// the reason 0009 shipped the whole `booking_status`: an `ALTER TYPE` later is a
// rewrite under an ACCESS EXCLUSIVE lock on the table.
export type PaymentStatus =
  | 'created'
  | 'pending'
  | 'success'
  | 'failed'
  | 'refunded'
  | 'partially_refunded';

export type PaymentMethod = 'card' | 'upi' | 'netbanking' | 'wallet' | 'emi' | 'cod';

// 0015. Five states of §12.3, shipped whole for the reason 0014 shipped all six
// of `payment_status`: `approved`/`rejected` are Phase 6's approval console
// (§25.10) writing into a table that already has a place for them, and adding a
// value later is an `ALTER TYPE` that rewrites `refunds` under an ACCESS
// EXCLUSIVE lock.
export type RefundStatus = 'requested' | 'approved' | 'rejected' | 'completed' | 'failed';

/**
 * 0015. Two values, not five.
 *
 * Direction is the whole of what this column is for — `apply_wallet_delta()`
 * reads it as `credit` or "not credit" — and *what* the movement was for is
 * carried by `ref_type`/`ref_id` on the ledger row instead. A `refund` value
 * would make direction ambiguous at exactly the point where an ambiguous
 * direction costs somebody money.
 */
export type WalletTxnType = 'credit' | 'debit';

/** Which of the two ways money goes back: the gateway instrument or the wallet. */
export type RefundRoute = 'gateway' | 'wallet' | 'mixed';

/** The three states `claim_idempotency_key` can return — it has four outcomes. */
export interface IdempotencyClaim {
  outcome: 'claimed' | 'replay' | 'in_flight' | 'conflict';
  stored_status: number | null;
  stored_body: object | null;
}

/**
 * A `numeric` column, as PostgREST actually returns it.
 *
 * A JSON number is a double, and a `numeric(12,2)` is not, so PostgREST sends
 * money and rates as strings and leaves it to the caller. Declared as `string`
 * here so that reading one is a deliberate `parseNumeric()` rather than a
 * silent float. Older blocks above use `number` for `numeric` columns; those
 * predate the phase that made money arithmetic load-bearing.
 */
export type Numeric = string;

type Timestamptz = string;

/**
 * Hand-maintained mirror of the generated Supabase `Database` type.
 *
 * Regenerate it with:
 *   npx supabase gen types typescript --project-id <ref> > lib/database.types.ts
 *
 * Only the tables of the current phase are present; later phases add their own
 * block. Row types are the single source of truth for `Table<...>` aliases in
 * lib/queries.ts, and for the shapes the API returns.
 */
/**
 * supabase-js 2.117 requires every table and view to carry a `Relationships`
 * entry before it will accept the type as a `GenericSchema`; leave it out and
 * the whole thing silently degrades to `never`, which surfaces as a wall of
 * unrelated "property does not exist on type never" errors in the routes.
 *
 * Declaring them once here beats hand-writing `Relationships: []` on eighteen
 * tables and forgetting two. Phase 0 has no PostgREST embedding, so "none" is
 * also the honest answer: when a phase starts selecting across a foreign key,
 * regenerate the whole block with
 *   npx supabase gen types typescript --project-id <ref> > lib/database.types.ts
 * and delete this shim.
 */
type WithRelationships<T> = { [K in keyof T]: T[K] & { Relationships: [] } };

type RawTables = {
      profiles: {
        Row: {
          id: string;
          role: UserRole;
          status: UserStatus;
          full_name: string;
          /** Optional: an email + password account has no number until it adds one (0027). */
          phone: string | null;
          phone_verified_at: Timestamptz | null;
          email: string | null;
          avatar_url: string | null;
          locale: string;
          last_seen_at: Timestamptz | null;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id: string;
          role?: UserRole;
          status?: UserStatus;
          full_name: string;
          phone?: string | null;
          phone_verified_at?: Timestamptz | null;
          email?: string | null;
          avatar_url?: string | null;
          locale?: string;
          last_seen_at?: Timestamptz | null;
        };
        Update: {
          role?: UserRole;
          status?: UserStatus;
          full_name?: string;
          phone?: string | null;
          phone_verified_at?: Timestamptz | null;
          email?: string | null;
          avatar_url?: string | null;
          locale?: string;
          last_seen_at?: Timestamptz | null;
        };
      };

      customers: {
        Row: {
          id: string;
          profile_id: string;
          referral_code: string;
          referred_by: string | null;
          wallet_id: string | null;
          total_bookings: number;
          completed_bookings: number;
          lifetime_value: number;
          cancelled_bookings: number;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: string;
          profile_id: string;
          referral_code: string;
          referred_by?: string | null;
        };
        Update: {
          referred_by?: string | null;
          wallet_id?: string | null;
        };
      };

      cities: {
        Row: {
          id: string;
          name: string;
          state: string;
          country: string;
          country_code: string;
          time_zone: string;
          default_currency: string;
          pincode_prefixes: string[];
          lat: number | null;
          lng: number | null;
          business_hours: Record<string, { open: string; close: string }>;
          is_active: boolean;
          created_at: Timestamptz;
        };
        Insert: Partial<RawTables['cities']['Row']> & {
          name: string;
          state: string;
        };
        Update: Partial<RawTables['cities']['Row']>;
      };

      localities: {
        Row: {
          id: string;
          city_id: string;
          name: string;
          lat: number;
          lng: number;
          radius_km: number;
          is_active: boolean;
          created_at: Timestamptz;
        };
        Insert: {
          id?: string;
          city_id: string;
          name: string;
          lat: number;
          lng: number;
          radius_km?: number;
        };
        Update: Partial<RawTables['localities']['Row']>;
      };

      service_categories: {
        Row: {
          id: string;
          name: string;
          slug: string;
          icon_key: string;
          image_url: string | null;
          sort_order: number;
          is_active: boolean;
          created_at: Timestamptz;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          icon_key: string;
          image_url?: string | null;
          sort_order?: number;
        };
        Update: Partial<RawTables['service_categories']['Row']>;
      };

      services: {
        Row: {
          id: string;
          category_id: string;
          name: string;
          slug: string;
          short_description: string | null;
          description: string | null;
          image_url: string | null;
          base_price: number;
          pricing_type: PricingType;
          unit_label: string | null;
          unit_price: number | null;
          min_duration_min: number;
          max_duration_min: number;
          prep_minutes: number;
          max_active_jobs: number;
          materials_included: boolean;
          materials_note: string | null;
          requires_photo_proof: boolean;
          sort_order: number;
          is_active: boolean;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: string;
          category_id: string;
          name: string;
          slug: string;
          base_price: number;
          pricing_type?: PricingType;
          min_duration_min?: number;
          max_duration_min?: number;
        };
        Update: Partial<RawTables['services']['Row']>;
      };

      service_tasks: {
        Row: {
          id: string;
          service_id: string;
          kind: 'included' | 'excluded';
          label: string;
          sort_order: number;
        };
        Insert: {
          id?: string;
          service_id: string;
          kind: 'included' | 'excluded';
          label: string;
          sort_order?: number;
        };
        Update: Partial<RawTables['service_tasks']['Row']>;
      };

      service_images: {
        Row: { id: string; service_id: string; url: string; alt_text: string | null; sort_order: number };
        Insert: { id?: string; service_id: string; url: string; alt_text?: string | null; sort_order?: number };
        Update: Partial<RawTables['service_images']['Row']>;
      };

      service_keywords: {
        Row: { service_id: string; keyword: string };
        Insert: { service_id: string; keyword: string };
        Update: { service_id: string; keyword: string };
      };

      service_areas: {
        Row: {
          id: string;
          locality_id: string;
          service_id: string;
          lead_minutes: number;
          slot_capacity: number;
          is_active: boolean;
          created_at: Timestamptz;
        };
        Insert: {
          id?: string;
          locality_id: string;
          service_id: string;
          lead_minutes?: number;
          slot_capacity?: number;
        };
        Update: Partial<RawTables['service_areas']['Row']>;
      };

      service_durations: {
        Row: {
          id: string;
          service_id: string;
          minutes: number;
          price: number | null;
          price_multiplier: number | null;
          is_active: boolean;
        };
        Insert: {
          id?: string;
          service_id: string;
          minutes: number;
          price?: number | null;
          price_multiplier?: number | null;
        };
        Update: Partial<RawTables['service_durations']['Row']>;
      };

      professionals: {
        Row: {
          id: string;
          profile_id: string;
          employee_code: string | null;
          verification_status: VerificationStatus;
          training_status: TrainingStatus;
          availability_status: AvailabilityStatus;
          is_available_today: boolean;
          current_lat: number | null;
          current_lng: number | null;
          location_updated_at: Timestamptz | null;
          service_radius_km: number;
          commission_pct: number;
          rating: number | null;
          rating_count: number;
          total_offers: number;
          accepted_offers: number;
          completed_jobs: number;
          cancelled_jobs: number;
          no_shows: number;
          experience_months: number;
          probation_until: Timestamptz | null;
          suspended_reason: string | null;
          kyc_verified_at: Timestamptz | null;
          onboarded_at: Timestamptz | null;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: string;
          profile_id: string;
          employee_code?: string | null;
          commission_pct?: number;
        };
        Update: Partial<RawTables['professionals']['Row']>;
      };

      professional_documents: {
        Row: {
          id: string;
          professional_id: string;
          doc_type: string;
          file_path: string;
          status: VerificationStatus;
          rejection_reason: string | null;
          reviewed_by: string | null;
          reviewed_at: Timestamptz | null;
          expires_at: Timestamptz | null;
          created_at: Timestamptz;
        };
        Insert: {
          id?: string;
          professional_id: string;
          doc_type: string;
          file_path: string;
          // Default is `not_submitted`; a professional may only ever write
          // `submitted`, and the guard trigger refuses anything else.
          status?: VerificationStatus;
        };
        Update: Partial<RawTables['professional_documents']['Row']>;
      };

      professional_skills: {
        Row: { professional_id: string; service_id: string; proficiency: number; verified_at: Timestamptz | null };
        Insert: { professional_id: string; service_id: string; proficiency?: number; verified_at?: Timestamptz | null };
        Update: { proficiency?: number; verified_at?: Timestamptz | null };
      };

      professional_working_hours: {
        Row: {
          id: string;
          professional_id: string;
          weekday: number;
          start_time: string;
          end_time: string;
          is_active: boolean;
        };
        Insert: {
          id?: string;
          professional_id: string;
          weekday: number;
          start_time: string;
          end_time: string;
        };
        Update: Partial<RawTables['professional_working_hours']['Row']>;
      };

      professional_time_off: {
        Row: {
          id: string;
          professional_id: string;
          starts_at: Timestamptz;
          ends_at: Timestamptz;
          reason: string | null;
        };
        Insert: { id?: string; professional_id: string; starts_at: string; ends_at: string; reason?: string | null };
        Update: Partial<RawTables['professional_time_off']['Row']>;
      };

      // 0008. `customer_id` is not updatable from a payload, so Update omits
      // it: `Partial<Row>` would otherwise offer it.
      addresses: {
        Row: {
          id: string;
          customer_id: string;
          /** NULL means the address is outside current coverage, not that it is broken. */
          locality_id: string | null;
          label: string;
          address_type: AddressType;
          line1: string;
          line2: string | null;
          area: string;
          city: string;
          state: string;
          pincode: string;
          lat: number;
          lng: number;
          landmark: string | null;
          access_notes: string | null;
          location_precision: LocationPrecision;
          is_default: boolean;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: string;
          customer_id: string;
          locality_id?: string | null;
          label?: string;
          address_type?: AddressType;
          line1: string;
          line2?: string | null;
          area: string;
          city: string;
          state: string;
          pincode: string;
          lat: number;
          lng: number;
          landmark?: string | null;
          access_notes?: string | null;
          location_precision?: LocationPrecision;
          is_default?: boolean;
        };
        Update: {
          locality_id?: string | null;
          label?: string;
          address_type?: AddressType;
          line1?: string;
          line2?: string | null;
          area?: string;
          city?: string;
          state?: string;
          pincode?: string;
          lat?: number;
          lng?: number;
          landmark?: string | null;
          access_notes?: string | null;
          location_precision?: LocationPrecision;
          is_default?: boolean;
        };
      };

      // ── Phase 2: the booking ────────────────────────────────────────
      //
      // Every money column is `Numeric`, never `number`: see the note on that
      // alias. The rates (`tax_rate`, `commission_pct`) are rates in [0,1] —
      // `0.1800`, not `18` — and `rates_are_rates` in 0010 is what catches
      // someone storing the latter.
      bookings: {
        Row: {
          id: string;
          booking_number: string;
          customer_id: string;
          professional_id: string | null;
          address_id: string;
          /** The address row frozen at creation. §24.7's dispute evidence. */
          address_snapshot: Record<string, unknown>;
          locality_id: string | null;
          city_id: string | null;
          booking_type: BookingType;
          status: BookingStatus;
          /** Optimistic lock (§28.1). Every mutation is `where id and version`. */
          version: number;
          scheduled_start_at: Timestamptz | null;
          scheduled_end_at: Timestamptz | null;
          duration_minutes: number;
          extended_minutes: number;
          subtotal: Numeric;
          platform_fee: Numeric;
          discount: Numeric;
          discount_code: string | null;
          tax: Numeric;
          tax_rate: Numeric;
          total_amount: Numeric;
          professional_gross: Numeric;
          commission_pct: Numeric;
          currency: string;
          quote_token: string | null;
          /** The engine's full breakdown, frozen. §24.7 "for audit". */
          pricing_snapshot: Record<string, unknown>;
          otp_hash: string | null;
          otp_expires_at: Timestamptz | null;
          otp_attempts: number;
          otp_generations: number;
          otp_verified_at: Timestamptz | null;
          started_at: Timestamptz | null;
          ends_at: Timestamptz | null;
          ended_at: Timestamptz | null;
          actual_duration_minutes: number | null;
          search_started_at: Timestamptz | null;
          search_expires_at: Timestamptz | null;
          matched_at: Timestamptz | null;
          accepted_at: Timestamptz | null;
          arrived_at: Timestamptz | null;
          eta_minutes: number | null;
          assignment_rounds: number;
          cancelled_at: Timestamptz | null;
          cancellation_reason_code: string | null;
          cancellation_fee: Numeric;
          completed_at: Timestamptz | null;
          closed_at: Timestamptz | null;
          notes: string | null;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: string;
          booking_number: string;
          customer_id: string;
          professional_id?: string | null;
          address_id: string;
          address_snapshot: Record<string, unknown>;
          booking_type: BookingType;
          locality_id?: string | null;
          city_id?: string | null;
          status?: BookingStatus;
          duration_minutes: number;
          scheduled_start_at?: Timestamptz | null;
          scheduled_end_at?: Timestamptz | null;
          /**
           * Money and rates, as `numeric` strings rather than numbers — see the
           * note on the `Numeric` alias above. Optional here because the columns
           * all default to 0, but `POST /api/bookings` always supplies them from
           * `toBookingMoneyColumns()`.
           */
          subtotal?: Numeric;
          platform_fee?: Numeric;
          discount?: Numeric;
          discount_code?: string | null;
          tax?: Numeric;
          tax_rate?: Numeric;
          total_amount?: Numeric;
          professional_gross?: Numeric;
          commission_pct?: Numeric;
          currency?: string;
          quote_token?: string | null;
          pricing_snapshot?: Record<string, unknown>;
          cancelled_at?: Timestamptz | null;
          cancellation_reason_code?: string | null;
          cancellation_fee?: Numeric;
          notes?: string | null;
        };
        Update: {
          status?: BookingStatus;
          scheduled_start_at?: Timestamptz | null;
          scheduled_end_at?: Timestamptz | null;
          duration_minutes?: number;
          professional_id?: string | null;
          notes?: string | null;
          cancelled_at?: Timestamptz | null;
          cancellation_reason_code?: string | null;
          cancellation_fee?: Numeric;
          completed_at?: Timestamptz | null;
          closed_at?: Timestamptz | null;
          pricing_snapshot?: Record<string, unknown>;
        };
      };

      booking_items: {
        Row: {
          id: string;
          booking_id: string;
          service_id: string;
          /** Snapshot: the catalogue is editable, the agreed name is not. */
          service_name: string;
          duration_minutes: number;
          unit_price: Numeric;
          quantity: number;
          line_total: Numeric;
          /** The included/excluded list the customer agreed to. */
          scope_snapshot: unknown[];
          created_at: Timestamptz;
        };
        Insert: {
          id?: string;
          booking_id: string;
          service_id: string;
          service_name: string;
          duration_minutes: number;
          unit_price: Numeric;
          quantity?: number;
          line_total: Numeric;
          scope_snapshot?: unknown[];
        };
        Update: Partial<RawTables['booking_items']['Row']>;
      };

      booking_status_history: {
        Row: {
          id: string;
          booking_id: string;
          from_status: BookingStatus | null;
          to_status: BookingStatus;
          actor_id: string | null;
          actor_role: UserRole | null;
          note: string | null;
          ip: string | null;
          created_at: Timestamptz;
        };
        Insert: {
          id?: string;
          booking_id: string;
          from_status?: BookingStatus | null;
          to_status: BookingStatus;
          actor_id?: string | null;
          actor_role?: UserRole | null;
          note?: string | null;
          ip?: string | null;
        };
        Update: never;
      };

      professional_schedule: {
        Row: {
          id: string;
          professional_id: string;
          /** NULL for a block of time off, which belongs to nobody. */
          booking_id: string | null;
          starts_at: Timestamptz;
          ends_at: Timestamptz;
          status: ScheduleStatus;
          created_at: Timestamptz;
        };
        Insert: {
          id?: string;
          professional_id: string;
          booking_id?: string | null;
          starts_at: string;
          ends_at: string;
          status?: ScheduleStatus;
        };
        Update: {
          status?: ScheduleStatus;
          starts_at?: Timestamptz;
          ends_at?: Timestamptz;
        };
      };

      coupons: {
        Row: {
          id: string;
          code: string;
          description: string | null;
          discount_type: DiscountType;
          /** Rupees for `fixed`, percent (0–100) for `percentage`. */
          discount_value: Numeric;
          max_discount: Numeric | null;
          min_booking_amount: Numeric;
          max_discount_pct_of_total: Numeric;
          valid_from: Timestamptz;
          valid_to: Timestamptz | null;
          usage_limit: number | null;
          /** A cache for rendering "3 of 10 left". `coupon_usage` is the truth. */
          usage_count: number;
          per_user_limit: number;
          applicable_services: string[];
          applicable_cities: string[];
          first_time_only: boolean;
          is_active: boolean;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: string;
          code: string;
          discount_type: DiscountType;
          discount_value: Numeric;
          max_discount?: Numeric | null;
          description?: string | null;
          min_booking_amount?: Numeric;
          max_discount_pct_of_total?: Numeric;
          applicable_services?: string[];
          applicable_cities?: string[];
        };
        Update: Partial<RawTables['coupons']['Row']>;
      };

      coupon_usage: {
        Row: {
          id: string;
          coupon_id: string;
          customer_id: string;
          booking_id: string;
          /** What it was actually worth after the cap, not what it is worth now. */
          discount_amount: Numeric;
          used_at: Timestamptz;
        };
        Insert: {
          id?: string;
          coupon_id: string;
          customer_id: string;
          booking_id: string;
          discount_amount: Numeric;
        };
        Update: never;
      };

      ratings: {
        Row: {
          id: string;
          /** UNIQUE — one review per booking; the edit path updates this row. */
          booking_id: string;
          customer_id: string;
          professional_id: string;
          overall: number;
          professionalism: number | null;
          quality: number | null;
          punctuality: number | null;
          behaviour: number | null;
          cleanliness: number | null;
          comment: string | null;
          pro_response: string | null;
          is_hidden: boolean;
          hidden_by: string | null;
          created_at: Timestamptz;
          responded_at: Timestamptz | null;
        };
        Insert: {
          id?: string;
          booking_id: string;
          customer_id: string;
          professional_id: string;
          overall: number;
          professionalism?: number | null;
          quality?: number | null;
          punctuality?: number | null;
          behaviour?: number | null;
          cleanliness?: number | null;
          comment?: string | null;
        };
        Update: {
          overall?: number;
          professionalism?: number | null;
          quality?: number | null;
          punctuality?: number | null;
          behaviour?: number | null;
          cleanliness?: number | null;
          comment?: string | null;
        };
      };

      // ── Phase 3: the charge attempt ──────────────────────────────────
      //
      // One row per charge attempt (0014), written *before* the gateway is
      // asked for an order. Every money column is `Numeric` — see the note on
      // that alias. `gateway_signature` is dispute evidence under §12.2 and is
      // redacted from audit metadata by `lib/audit.ts`; it never appears in a
      // browser response either.
      //
      // There is deliberately no INSERT/UPDATE policy on this table: the
      // service role is the only writer, and a browser that could insert a row
      // could set `status = 'success'` itself. RLS protects the browser and
      // PostgREST only — Route Handlers bypass it, which is why
      // `getPaymentForCaller()` exists.
      payments: {
        Row: {
          id: string;
          booking_id: string | null;
          customer_id: string;
          purpose: PaymentPurpose;
          amount: Numeric;
          currency: string;
          gateway: string;
          gateway_order_id: string | null;
          gateway_payment_id: string | null;
          gateway_signature: string | null;
          status: PaymentStatus;
          method: PaymentMethod | null;
          refundable_amount: Numeric;
          failure_reason: string | null;
          idempotency_key: string | null;
          captured_at: Timestamptz | null;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: string;
          booking_id?: string | null;
          customer_id: string;
          purpose?: PaymentPurpose;
          amount: Numeric;
          currency?: string;
          gateway?: string;
          gateway_order_id?: string | null;
          gateway_payment_id?: string | null;
          gateway_signature?: string | null;
          status?: PaymentStatus;
          method?: PaymentMethod | null;
          refundable_amount?: Numeric;
          failure_reason?: string | null;
          idempotency_key?: string | null;
          captured_at?: Timestamptz | null;
        };
        Update: {
          booking_id?: string | null;
          gateway_order_id?: string | null;
          gateway_payment_id?: string | null;
          gateway_signature?: string | null;
          status?: PaymentStatus;
          method?: PaymentMethod | null;
          refundable_amount?: Numeric;
          failure_reason?: string | null;
          captured_at?: Timestamptz | null;
        };
      };

      // ── Phase 3: money going back out ────────────────────────────────
      //
      // 0015. The refund record, the wallet and its ledger. Three tables that
      // exist because "the customer got their money back" has to be checkable
      // months later — which is why `route` distinguishes the two ways it can
      // happen, why `gateway_refund_id` is written as soon as the gateway
      // answers, and why there is no INSERT/UPDATE policy on any of them: the
      // service role is the only writer, and a browser that could insert a
      // refund could set `status = 'completed'` and hand itself money.
      refunds: {
        Row: {
          id: string;
          payment_id: string;
          booking_id: string;
          customer_id: string;
          amount: Numeric;
          currency: string;
          status: RefundStatus;
          route: RefundRoute;
          reason_code: string;
          note: string | null;
          gateway_refund_id: string | null;
          requested_by: string | null;
          processed_by: string | null;
          approved_by: string | null;
          requested_at: Timestamptz;
          completed_at: Timestamptz | null;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: string;
          payment_id: string;
          booking_id: string;
          customer_id: string;
          amount: Numeric;
          currency?: string;
          status?: RefundStatus;
          route?: RefundRoute;
          reason_code: string;
          note?: string | null;
          gateway_refund_id?: string | null;
          requested_by?: string | null;
          processed_by?: string | null;
          approved_by?: string | null;
          requested_at?: Timestamptz;
          completed_at?: Timestamptz | null;
        };
        Update: {
          status?: RefundStatus;
          route?: RefundRoute;
          reason_code?: string;
          note?: string | null;
          gateway_refund_id?: string | null;
          processed_by?: string | null;
          approved_by?: string | null;
          completed_at?: Timestamptz | null;
        };
      };

      // The balance is a cache of `wallet_transactions`; the ledger is what is
      // actually trusted. Hence `balance >= 0` as a column CHECK *and* as a
      // pre-write guard inside `apply_wallet_delta()`, and hence no touch
      // trigger: the function is the only writer and sets `updated_at` itself.
      wallets: {
        Row: {
          id: string;
          customer_id: string;
          balance: Numeric;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: string;
          customer_id: string;
          balance?: Numeric;
        };
        // There is deliberately no Update block worth having: no UPDATE policy
        // admits anybody, and `apply_wallet_delta()` runs as `security definer`.
        Update: {
          balance?: Numeric;
        };
      };

      // Append-only. `balance_after` is written by `apply_wallet_delta()` because
      // §12.4's own INSERT forgot it and §24.9 declares it NOT NULL — a reader can
      // re-run the ledger and check it against `wallets.balance` without trusting
      // either one. The two `wallet_txn_no_*` policies refuse an UPDATE and a
      // DELETE outright (§12.4).
      wallet_transactions: {
        Row: {
          id: string;
          wallet_id: string;
          type: WalletTxnType;
          amount: Numeric;
          balance_after: Numeric;
          ref_type: string;
          ref_id: string | null;
          description: string;
          created_at: Timestamptz;
        };
        Insert: {
          id?: string;
          wallet_id: string;
          type: WalletTxnType;
          amount: Numeric;
          balance_after: Numeric;
          ref_type: string;
          ref_id?: string | null;
          description: string;
        };
        Update: {
          // Mirrored for completeness only: no UPDATE policy admits anybody and
          // `authenticated` holds no UPDATE grant, so this shape is not
          // reachable from a client. The append-only property is enforced below
          // the type system, in 0015's two `wallet_txn_no_*` policies.
          type?: WalletTxnType;
          amount?: Numeric;
          balance_after?: Numeric;
          ref_type?: string;
          ref_id?: string | null;
          description?: string;
        };
      };
};

type RawViews = {
  public_professionals: {
    Row: {
      id: string;
          full_name: string;
          avatar_url: string | null;
          rating: number | null;
          rating_count: number;
          completed_jobs: number;
          experience_months: number;
          verification_status: VerificationStatus;
          training_status: TrainingStatus;
          is_available_today: boolean;
          availability_status: AvailabilityStatus;
          service_radius_km: number;
      onboarded_at: Timestamptz | null;
    };
  };
};

export type Database = {
  public: {
    Tables: WithRelationships<RawTables>;
    Views: WithRelationships<RawViews>;

    Functions: {
      current_role: { Args: Record<PropertyKey, never>; Returns: UserRole };
      current_status: { Args: Record<PropertyKey, never>; Returns: UserStatus };
      is_staff: { Args: { p_roles: UserRole[] }; Returns: boolean };
      is_admin: { Args: Record<PropertyKey, never>; Returns: boolean };
      is_ops: { Args: Record<PropertyKey, never>; Returns: boolean };
      is_trusted_session: { Args: Record<PropertyKey, never>; Returns: boolean };
      current_customer_id: { Args: Record<PropertyKey, never>; Returns: string | null };
      current_professional_id: { Args: Record<PropertyKey, never>; Returns: string | null };
      is_serviceable: {
        Args: { p_locality_id: string; p_service_id: string; p_at?: string | null };
        Returns: boolean;
      };
      /** 0008. Clears the customer's default and sets this one, atomically. */
      set_default_address: {
        Args: { p_customer_id: string; p_address_id: string };
        Returns: string;
      };

      // Phase 0 auth. The ledger lives in SQL so the attempt counter, the
      // resend throttle and the lockout cannot be raced by two requests.
      // Both are `security definer` and callable by `service_role` only.
      issue_otp: {
        Args: {
          p_target: string;
          p_channel: OtpChannel;
          p_purpose: OtpPurpose;
          p_code: string;
          p_ttl_minutes: number;
          p_max_attempts: number;
          p_resend_seconds: number;
          p_lockout_minutes: number;
        };
        Returns: string;
      };
      consume_otp: {
        Args: { p_target: string; p_purpose: OtpPurpose; p_code: string };
        Returns: OtpOutcome;
      };

      // Phase 0 platform plumbing (§29.2). Both are security definer and are
      // revoked from PUBLIC; only service_role may call them.
      write_audit: {
        Args: {
          p_actor_profile_id: string | null;
          p_action: string;
          p_entity_type: string;
          p_entity_id: string | null;
          p_before_state: object | null;
          p_after_state: object | null;
          p_metadata: object | null;
          p_ip_address: string | null;
          p_user_agent: string | null;
          p_request_id: string | null;
        };
        Returns: string;
      };
      claim_idempotency_key: {
        Args: {
          p_key: string;
          p_operation: string;
          p_actor_profile_id: string | null;
          p_request_hash: string;
        };
        Returns: IdempotencyClaim;
      };
      complete_idempotency_key: {
        Args: {
          p_key: string;
          p_operation: string;
          p_actor_profile_id: string | null;
          p_status: number;
          p_body: object | null;
        };
        Returns: undefined;
      };

      /** 0010. One global sequence, rendered `SH-YYYYMMDD-NNNNN`. */
      next_booking_number: {
        Args: { p_at?: string | null };
        Returns: string;
      };

      /**
       * 0028. The booking, its items and the `draft -> payment_pending` hop in
       * one statement. `p_money` carries the pricing columns as the text literals
       * `toBookingMoneyColumns()` already produced.
       */
      create_booking: {
        Args: {
          p_customer_id: string;
          p_address_id: string;
          p_locality_id: string | null;
          p_address_snapshot: object;
          p_booking_type: Database['public']['Enums']['booking_type'];
          p_duration_minutes: number;
          p_scheduled_start_at: string | null;
          p_scheduled_end_at: string | null;
          p_notes: string | null;
          p_money: Record<string, string>;
          p_discount_code: string | null;
          p_pricing_snapshot: object;
          p_quote_token: string | null;
          p_items: Array<Record<string, unknown>>;
          p_actor: string | null;
          p_actor_role: Database['public']['Enums']['user_role'] | null;
        };
        Returns: Database['public']['Tables']['bookings']['Row'];
      };

      /** 0028. Status move plus the actor in `booking_status_history`. */
      transition_booking: {
        Args: {
          p_booking_id: string;
          p_to: Database['public']['Enums']['booking_status'];
          p_actor: string | null;
          p_actor_role: Database['public']['Enums']['user_role'] | null;
          p_note: string | null;
          p_expected_version: number | null;
          p_window_from: string | null;
          p_window_to: string | null;
        };
        Returns: Database['public']['Tables']['bookings']['Row'];
      };

      /**
       * 0028. Cancellation, its reason and its fee in the same statement. Null
       * comes back when the version has moved on.
       */
      cancel_booking: {
        Args: {
          p_booking_id: string;
          p_expected_version: number | null;
          p_reason_code: string | null;
          p_fee: number;
          p_note: string | null;
          p_actor: string | null;
          p_actor_role: Database['public']['Enums']['user_role'] | null;
        };
        Returns: Database['public']['Tables']['bookings']['Row'];
      };

      /**
       * 0014. The single writer of `payments.status = 'success'`. Moves the
       * payment and the booking in one transaction, and returns **null** when
       * the replay guard matched no row — the webhook and the reconcile cron
       * both branch on that to log a duplicate instead of re-confirming.
       *
       * The two ids the WHERE clause matches on are non-null here: a payment id
       * or order id of null can only match nothing, so accepting one would turn
       * a caller's bug into a silent "duplicate" answer. The two evidence fields
       * are nullable because the reconcile cron legitimately has neither — an
       * order fetch cannot see a payment id or its signature, and the webhook is
       * what stores both.
       */
      confirm_booking_payment: {
        Args: {
          p_payment_id: string;
          p_gateway_order_id: string;
          p_booking_id: string;
          p_gateway_payment_id: string | null;
          p_gateway_signature: string | null;
          p_note: string;
        };
        Returns: Database['public']['Tables']['payments']['Row'];
      };

      // ── Phase 3: the refund's four statements ─────────────────────────
      //
      // 0015. All four are `security definer`, all four are revoked from PUBLIC
      // and granted to `service_role` only, and every caller is a Route
      // Handler. The move is always two rows in one transaction — the refund
      // and the booking, or the balance and the ledger — so a half-refunded
      // payment is not a state this schema can reach.

      /** Returns the customer's wallet, creating it on first credit. One statement, because read-then-write on a UNIQUE is a race. */
      get_or_create_wallet: {
        Args: { p_customer: string };
        Returns: string;
      };

      /**
       * Moves a balance and writes its ledger row, or raises `WALLET_OVERDRAFT`
       * (SQLSTATE 23514 — the same code the column CHECK gives) *before* either
       * write. `p_amount` is always positive: direction is `p_type`. Returns the
       * new balance.
       *
       * `p_amount` is typed `Numeric` — a string — where the generated type
       * would say `number`. Every other money figure in this codebase enters
       * Postgres as an exact decimal string (`payments.amount = numericLiteral(…)`)
       * for the reason `lib/money.ts` gives: a JSON float is not a `numeric`.
       * PostgREST coerces a string argument to `numeric` (probed against the live
       * project), so this hand-maintained mirror keeps the invariant rather than
       * the generated shape.
       */
      apply_wallet_delta: {
        Args: {
          p_wallet: string;
          p_type: WalletTxnType;
          p_amount: Numeric;
          p_ref: string;
          p_desc: string;
        };
        Returns: number;
      };

      /**
       * Inserts the refund and hops the booking to `refund_pending` — but only
       * from `paid` or `cancelled`, so a request that is never executed cannot
       * strand a booking. Refuses an amount above `payments.refundable_amount`
       * before the row exists.
       *
       * `p_amount` is a string for the same reason as `apply_wallet_delta`'s.
       */
      record_booking_refund: {
        Args: {
          p_payment_id: string;
          p_booking_id: string;
          p_amount: Numeric;
          p_reason_code: string;
          p_route: string;
          p_note: string | null;
          p_requested_by: string | null;
        };
        Returns: Database['public']['Tables']['refunds']['Row'];
      };

      /**
       * Completes the refund, hops the booking to `refunded` and draws the
       * payment's remainder down in one transaction. Returns **null** when the
       * refund was already completed — the replay guard the `refund.processed`
       * webhook branches on, so a re-delivered event refunds nothing twice.
       */
      complete_booking_refund: {
        Args: {
          p_refund_id: string;
          p_gateway_refund_id: string | null;
          p_route: string | null;
          p_note: string | null;
          p_processed_by: string | null;
        };
        Returns: Database['public']['Tables']['refunds']['Row'] | null;
      };
    };

    Enums: {
      user_role: UserRole;
      user_status: UserStatus;
      verification_status: VerificationStatus;
      training_status: TrainingStatus;
      availability_status: AvailabilityStatus;
      pricing_type: PricingType;
      address_type: AddressType;
      booking_type: BookingType;
      booking_status: BookingStatus;
      discount_type: DiscountType;
      payment_purpose: PaymentPurpose;
      payment_status: PaymentStatus;
      payment_method: PaymentMethod;
      refund_status: RefundStatus;
      wallet_txn_type: WalletTxnType;
      schedule_status: ScheduleStatus;
    };
  };
};

type Schema = Database['public'];

export type Tables<T extends keyof Schema['Tables']> = Schema['Tables'][T]['Row'];
export type TablesInsert<T extends keyof Schema['Tables']> = Schema['Tables'][T]['Insert'];
export type TablesUpdate<T extends keyof Schema['Tables']> = Schema['Tables'][T]['Update'];

export type Profile = Tables<'profiles'>;
export type Customer = Tables<'customers'>;
export type Address = Tables<'addresses'>;
export type Service = Tables<'services'>;
export type ServiceTask = Tables<'service_tasks'>;
export type ServiceCategory = Tables<'service_categories'>;
export type Locality = Tables<'localities'>;
export type Professional = Tables<'professionals'>;
export type PublicProfessional = Schema['Views']['public_professionals']['Row'];
export type Booking = Tables<'bookings'>;
export type BookingItem = Tables<'booking_items'>;
export type BookingStatusHistory = Tables<'booking_status_history'>;
export type ProfessionalSchedule = Tables<'professional_schedule'>;
export type Coupon = Tables<'coupons'>;
export type CouponUsage = Tables<'coupon_usage'>;
export type Rating = Tables<'ratings'>;
export type Payment = Tables<'payments'>;
export type Refund = Tables<'refunds'>;
export type Wallet = Tables<'wallets'>;
export type WalletTransaction = Tables<'wallet_transactions'>;
