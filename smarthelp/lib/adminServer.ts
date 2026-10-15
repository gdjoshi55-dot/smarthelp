import { createServerClient } from './supabaseServer';
import { parseNumeric } from './money';
import { DEFAULT_TIMEZONE } from './constants';
import { wallClockToInstant, zoneDate } from './availability';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BookingStatus,
  Database,
  RefundStatus,
  VerificationStatus,
} from './supabase';

/**
 * The admin console's read models (§20.11, §22, §31.1).
 *
 * Every list and detail screen under `/admin` reads through this module. Two
 * rules hold across all of it:
 *
 *   The service role is used, so **scope is this file's job**, not RLS's. Each
 *   function filters explicitly by whatever the caller is allowed to see. A
 *   cross-tenant id in a path resolves to `null` here, which the route turns
 *   into a 404 with no write — the D3 decision.
 *
 *   Money leaves as a **number of rupees**. `numeric` columns arrive as strings
 *   (see the `Numeric` alias in `lib/supabase.ts`); they are parsed once at this
 *   boundary so no consumer of a read model ever holds a numeric string.
 *
 * The display joins are manual (`customers → profiles`, `professionals →
 * profiles`) rather than PostgREST embeds, for the reason the rest of the tree
 * gives: the hand-maintained `Database` type declares no relationships, so an
 * embed would not typecheck and would fetch a shape nothing else expects.
 */

// ── Shared helpers ───────────────────────────────────────────

type TableName = keyof Database['public']['Tables'];

async function countWhere(
  supabase: SupabaseClient<Database>,
  table: TableName,
  build?: (q: any) => any
): Promise<number> {
  let query: any = supabase.from(table).select('id', { count: 'exact', head: true });
  if (build) query = build(query);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

/** The start of "today" in the platform zone, as an instant. */
function startOfTodayIso(now = new Date(), timeZone = DEFAULT_TIMEZONE): string {
  return wallClockToInstant(zoneDate(now, timeZone), 0, timeZone).toISOString();
}

// ── Dashboard ────────────────────────────────────────────────

export interface DashboardSummary {
  bookings: {
    today: number;
    completedToday: number;
    cancelledToday: number;
    /** Paid or searching with no professional yet assigned. */
    awaitingProfessional: number;
    /** Somebody is on the way, on site, or working. */
    inProgress: number;
  };
  /** Rupees: the day's gross booking value, cancelled and unpaid excluded. */
  gmvToday: number;
  professionals: {
    total: number;
    verified: number;
    online: number;
    /** Documents awaiting a KYC verdict. */
    pendingKyc: number;
  };
  refunds: {
    pendingApproval: number;
  };
}

const LIVE_STATUSES: BookingStatus[] = [
  'assigned',
  'accepted',
  'on_the_way',
  'arrived',
  'otp_verified',
  'in_progress',
  'extension_requested',
];

/**
 * The operational dashboard (§20.11). Today's shape, in one round of counts.
 *
 * The queries run in parallel; the day's GMV is the only one that fetches rows,
 * because it sums a column rather than counting.
 */
export async function getDashboardSummary(
  supabase: SupabaseClient<Database> = createServerClient(),
  now = new Date()
): Promise<DashboardSummary> {
  const dayStart = startOfTodayIso(now);

  const [
    bookingsToday,
    completedToday,
    cancelledToday,
    awaitingProfessional,
    inProgress,
    professionalsTotal,
    professionalsVerified,
    professionalsOnline,
    pendingKyc,
    pendingRefunds,
    gmvRows,
  ] = await Promise.all([
    countWhere(supabase, 'bookings', (q) => q.gte('created_at', dayStart)),
    countWhere(supabase, 'bookings', (q) =>
      q.eq('status', 'completed').gte('completed_at', dayStart)
    ),
    countWhere(supabase, 'bookings', (q) =>
      q.eq('status', 'cancelled').gte('cancelled_at', dayStart)
    ),
    countWhere(supabase, 'bookings', (q) => q.in('status', ['paid', 'searching'])),
    countWhere(supabase, 'bookings', (q) => q.in('status', LIVE_STATUSES)),
    countWhere(supabase, 'professionals'),
    countWhere(supabase, 'professionals', (q) => q.eq('verification_status', 'verified')),
    countWhere(supabase, 'professionals', (q) => q.eq('availability_status', 'online')),
    countWhere(supabase, 'professional_documents', (q) =>
      q.in('status', ['submitted', 'in_review'])
    ),
    countWhere(supabase, 'refunds', (q) => q.eq('status', 'requested')),
    supabase
      .from('bookings')
      .select('total_amount, status')
      .gte('created_at', dayStart),
  ]);

  if (gmvRows.error) throw gmvRows.error;
  const gmvToday = (gmvRows.data ?? [])
    .filter((r) => r.status !== 'cancelled' && r.status !== 'draft' && r.status !== 'payment_pending')
    .reduce((sum, r) => sum + parseNumeric(r.total_amount), 0);

  return {
    bookings: {
      today: bookingsToday,
      completedToday,
      cancelledToday,
      awaitingProfessional,
      inProgress,
    },
    gmvToday,
    professionals: {
      total: professionalsTotal,
      verified: professionalsVerified,
      online: professionalsOnline,
      pendingKyc,
    },
    refunds: { pendingApproval: pendingRefunds },
  };
}

// ── Bookings ─────────────────────────────────────────────────

export interface AdminBookingListItem {
  id: string;
  bookingNumber: string;
  status: BookingStatus;
  bookingType: string;
  customerName: string | null;
  professionalName: string | null;
  serviceName: string | null;
  totalAmount: number;
  currency: string;
  scheduledStartAt: string | null;
  createdAt: string;
}

export interface AdminBookingListFilters {
  status?: BookingStatus;
  /** A booking-number substring. */
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function listAdminBookings(
  filters: AdminBookingListFilters = {},
  supabase: SupabaseClient<Database> = createServerClient()
): Promise<{ bookings: AdminBookingListItem[]; total: number; limit: number; offset: number }> {
  const limit = filters.limit ?? 25;
  const offset = filters.offset ?? 0;

  let query = supabase.from('bookings').select('*', { count: 'exact' });
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.q) query = query.ilike('booking_number', `%${filters.q}%`);
  if (filters.from) query = query.gte('created_at', filters.from);
  if (filters.to) query = query.lte('created_at', filters.to);

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const rows = data ?? [];
  const names = await displayNames(supabase, rows);

  const bookings = rows.map((row) => ({
    id: row.id,
    bookingNumber: row.booking_number,
    status: row.status,
    bookingType: row.booking_type,
    customerName: names.customers[row.customer_id] ?? null,
    professionalName: row.professional_id ? names.professionals[row.professional_id] ?? null : null,
    serviceName: names.services[row.id] ?? null,
    totalAmount: parseNumeric(row.total_amount),
    currency: row.currency,
    scheduledStartAt: row.scheduled_start_at,
    createdAt: row.created_at,
  }));

  return { bookings, total: count ?? 0, limit, offset };
}

/** Resolves customer/professional display names and first-service names for a page of bookings. */
async function displayNames(
  supabase: SupabaseClient<Database>,
  rows: Database['public']['Tables']['bookings']['Row'][]
): Promise<{
  customers: Record<string, string>;
  professionals: Record<string, string>;
  services: Record<string, string>;
}> {
  const customerIds = [...new Set(rows.map((r) => r.customer_id))];
  const professionalIds = [...new Set(rows.map((r) => r.professional_id).filter((v): v is string => !!v))];
  const bookingIds = rows.map((r) => r.id);

  const [customersRes, professionalsRes, itemsRes] = await Promise.all([
    customerIds.length
      ? supabase.from('customers').select('id, profile_id').in('id', customerIds)
      : Promise.resolve({ data: [], error: null } as const),
    professionalIds.length
      ? supabase.from('professionals').select('id, profile_id').in('id', professionalIds)
      : Promise.resolve({ data: [], error: null } as const),
    bookingIds.length
      ? supabase
          .from('booking_items')
          .select('booking_id, service_name')
          .in('booking_id', bookingIds)
          .order('created_at', { ascending: true })
      : Promise.resolve({ data: [], error: null } as const),
  ]);
  if (customersRes.error) throw customersRes.error;
  if (professionalsRes.error) throw professionalsRes.error;
  if (itemsRes.error) throw itemsRes.error;

  const profileIds = [
    ...(customersRes.data ?? []).map((c) => c.profile_id),
    ...(professionalsRes.data ?? []).map((p) => p.profile_id),
  ];
  const profilesRes = profileIds.length
    ? await supabase.from('profiles').select('id, full_name').in('id', [...new Set(profileIds)])
    : { data: [], error: null as null };
  if (profilesRes.error) throw profilesRes.error;
  const nameById = Object.fromEntries((profilesRes.data ?? []).map((p) => [p.id, p.full_name]));

  return {
    customers: Object.fromEntries(
      (customersRes.data ?? []).map((c) => [c.id, nameById[c.profile_id] ?? 'Customer'])
    ),
    professionals: Object.fromEntries(
      (professionalsRes.data ?? []).map((p) => [p.id, nameById[p.profile_id] ?? 'Professional'])
    ),
    services: Object.fromEntries(
      (itemsRes.data ?? []).map((i) => [i.booking_id, i.service_name])
    ),
  };
}

export interface AdminBookingDetail {
  booking: Database['public']['Tables']['bookings']['Row'];
  customer: { id: string; name: string | null } | null;
  professional: { id: string; name: string | null } | null;
  items: Database['public']['Tables']['booking_items']['Row'][];
  history: Database['public']['Tables']['booking_status_history']['Row'][];
  assignments: Database['public']['Tables']['booking_assignments']['Row'][];
  payments: Database['public']['Tables']['payments']['Row'][];
  refunds: Database['public']['Tables']['refunds']['Row'][];
}

/**
 * One booking, fully (§20.12). Returns `null` for an id that does not exist —
 * the route maps that to a 404 and writes nothing.
 */
export async function getAdminBooking(
  bookingId: string,
  supabase: SupabaseClient<Database> = createServerClient()
): Promise<AdminBookingDetail | null> {
  const { data: booking, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!booking) return null;

  const [itemsRes, historyRes, assignmentsRes, paymentsRes, refundsRes] = await Promise.all([
    supabase.from('booking_items').select('*').eq('booking_id', bookingId),
    supabase
      .from('booking_status_history')
      .select('*')
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: true }),
    supabase
      .from('booking_assignments')
      .select('*')
      .eq('booking_id', bookingId)
      .order('offered_at', { ascending: false }),
    supabase.from('payments').select('*').eq('booking_id', bookingId),
    supabase.from('refunds').select('*').eq('booking_id', bookingId),
  ]);
  if (itemsRes.error) throw itemsRes.error;
  if (historyRes.error) throw historyRes.error;
  if (assignmentsRes.error) throw assignmentsRes.error;
  if (paymentsRes.error) throw paymentsRes.error;
  if (refundsRes.error) throw refundsRes.error;

  const names = await displayNames(supabase, [booking]);

  return {
    booking,
    customer: { id: booking.customer_id, name: names.customers[booking.customer_id] ?? null },
    professional: booking.professional_id
      ? {
          id: booking.professional_id,
          name: names.professionals[booking.professional_id] ?? null,
        }
      : null,
    items: itemsRes.data ?? [],
    history: historyRes.data ?? [],
    assignments: assignmentsRes.data ?? [],
    payments: paymentsRes.data ?? [],
    refunds: refundsRes.data ?? [],
  };
}

// ── Professionals ────────────────────────────────────────────

export interface AdminProfessionalListItem {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  employeeCode: string | null;
  verificationStatus: VerificationStatus;
  availabilityStatus: string;
  isAvailableToday: boolean;
  rating: number | null;
  completedJobs: number;
  totalOffers: number;
  acceptedOffers: number;
  createdAt: string;
}

export interface AdminProfessionalListFilters {
  verificationStatus?: VerificationStatus;
  availabilityStatus?: string;
  /** A name substring. */
  q?: string;
  /** Only professionals with a document awaiting a verdict (the §20.13 queue). */
  pendingKyc?: boolean;
  limit?: number;
  offset?: number;
}

export async function listAdminProfessionals(
  filters: AdminProfessionalListFilters = {},
  supabase: SupabaseClient<Database> = createServerClient()
): Promise<{
  professionals: AdminProfessionalListItem[];
  total: number;
  limit: number;
  offset: number;
}> {
  const limit = filters.limit ?? 25;
  const offset = filters.offset ?? 0;

  // A name search resolves against `profiles` first, because the name lives
  // there — the same manual join the rest of the tree uses.
  let profileIds: string[] | null = null;
  if (filters.q) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id')
      .ilike('full_name', `%${filters.q}%`);
    if (error) throw error;
    profileIds = (data ?? []).map((p) => p.id);
    if (profileIds.length === 0) {
      return { professionals: [], total: 0, limit, offset };
    }
  }

  // The KYC queue: professionals who have a document waiting on a verdict. It
  // is a join, so the ids are resolved first; an empty set means an empty page,
  // not a full one — the same reasoning as the name search above.
  let pendingIds: string[] | null = null;
  if (filters.pendingKyc) {
    const { data, error } = await supabase
      .from('professional_documents')
      .select('professional_id')
      .in('status', ['submitted', 'in_review']);
    if (error) throw error;
    pendingIds = [...new Set((data ?? []).map((d) => d.professional_id))];
    if (pendingIds.length === 0) {
      return { professionals: [], total: 0, limit, offset };
    }
  }

  let query = supabase.from('professionals').select('*', { count: 'exact' });
  if (filters.verificationStatus) query = query.eq('verification_status', filters.verificationStatus);
  if (filters.availabilityStatus) {
    query = query.eq(
      'availability_status',
      filters.availabilityStatus as Database['public']['Enums']['availability_status']
    );
  }
  if (profileIds) query = query.in('profile_id', profileIds);
  if (pendingIds) query = query.in('id', pendingIds);

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const rows = data ?? [];
  const profiles = await profilesFor(supabase, rows.map((r) => r.profile_id));

  const professionals = rows.map((row) => {
    const profile = profiles[row.profile_id];
    return {
      id: row.id,
      name: profile?.full_name ?? null,
      phone: profile?.phone ?? null,
      email: profile?.email ?? null,
      employeeCode: row.employee_code,
      verificationStatus: row.verification_status,
      availabilityStatus: row.availability_status,
      isAvailableToday: row.is_available_today,
      rating: row.rating,
      completedJobs: row.completed_jobs,
      totalOffers: row.total_offers,
      acceptedOffers: row.accepted_offers,
      createdAt: row.created_at,
    };
  });

  return { professionals, total: count ?? 0, limit, offset };
}

async function profilesFor(
  supabase: SupabaseClient<Database>,
  ids: string[]
): Promise<Record<string, Database['public']['Tables']['profiles']['Row']>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return {};
  const { data, error } = await supabase.from('profiles').select('*').in('id', unique);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((p) => [p.id, p]));
}

export interface AdminProfessionalDetail {
  professional: Database['public']['Tables']['professionals']['Row'];
  profile: Database['public']['Tables']['profiles']['Row'] | null;
  documents: Database['public']['Tables']['professional_documents']['Row'][];
  skills: { service_id: string; proficiency: number }[];
  recentBookings: AdminBookingListItem[];
}

export async function getAdminProfessional(
  professionalId: string,
  supabase: SupabaseClient<Database> = createServerClient()
): Promise<AdminProfessionalDetail | null> {
  const { data: professional, error } = await supabase
    .from('professionals')
    .select('*')
    .eq('id', professionalId)
    .maybeSingle();
  if (error) throw error;
  if (!professional) return null;

  const [profileRes, documentsRes, skillsRes, bookingsRes] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', professional.profile_id).maybeSingle(),
    supabase
      .from('professional_documents')
      .select('*')
      .eq('professional_id', professionalId)
      .order('created_at', { ascending: false }),
    supabase
      .from('professional_skills')
      .select('service_id, proficiency')
      .eq('professional_id', professionalId),
    supabase
      .from('bookings')
      .select('*')
      .eq('professional_id', professionalId)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);
  if (profileRes.error) throw profileRes.error;
  if (documentsRes.error) throw documentsRes.error;
  if (skillsRes.error) throw skillsRes.error;
  if (bookingsRes.error) throw bookingsRes.error;

  const bookingRows = bookingsRes.data ?? [];
  const names = await displayNames(supabase, bookingRows);

  const recentBookings: AdminBookingListItem[] = bookingRows.map((row) => ({
    id: row.id,
    bookingNumber: row.booking_number,
    status: row.status,
    bookingType: row.booking_type,
    customerName: names.customers[row.customer_id] ?? null,
    professionalName: names.professionals[row.professional_id ?? ''] ?? null,
    serviceName: names.services[row.id] ?? null,
    totalAmount: parseNumeric(row.total_amount),
    currency: row.currency,
    scheduledStartAt: row.scheduled_start_at,
    createdAt: row.created_at,
  }));

  return {
    professional,
    profile: profileRes.data ?? null,
    documents: documentsRes.data ?? [],
    skills: skillsRes.data ?? [],
    recentBookings,
  };
}

/**
 * A professional eligible for manual assignment: verified, and a live row.
 * Used by the assign route to refuse an unverified professional before the RPC
 * returns its own verdict.
 */
export async function getAssignableProfessional(
  professionalId: string,
  supabase: SupabaseClient<Database> = createServerClient()
): Promise<{ id: string; name: string | null; verificationStatus: VerificationStatus } | null> {
  const { data, error } = await supabase
    .from('professionals')
    .select('id, profile_id, verification_status')
    .eq('id', professionalId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', data.profile_id)
    .maybeSingle();

  return {
    id: data.id,
    name: profile?.full_name ?? null,
    verificationStatus: data.verification_status,
  };
}

// ── KYC review ───────────────────────────────────────────────

/** A document row plus a short-lived URL to look at the bytes (§20.13). */
export type KycReviewDocument = Database['public']['Tables']['professional_documents']['Row'] & {
  signedUrl: string | null;
};

export interface KycReview {
  professional: Database['public']['Tables']['professionals']['Row'];
  profile: Database['public']['Tables']['profiles']['Row'] | null;
  documents: KycReviewDocument[];
  skills: { service_id: string; proficiency: number }[];
}

/** The signed-read lifetime. Long enough to review one document, short enough to leak safely. */
const KYC_SIGNED_URL_TTL_SECONDS = 300;

/**
 * The KYC review screen's read model (§20.13).
 *
 * The `kyc-documents` bucket is private and has no select policy, so the bytes
 * are reachable only through a signed URL minted here — by the service role,
 * after the route has already checked the caller is staff. The URL is the *only*
 * way in; metadata alone would not let a reviewer see what they are judging.
 *
 * A document whose object is missing still returns a row, with `signedUrl: null`:
 * a reviewer needs to see that the professional uploaded a document that has
 * since gone, not an empty page.
 */
export async function getKycReview(
  professionalId: string,
  supabase: SupabaseClient<Database> = createServerClient()
): Promise<KycReview | null> {
  const { data: professional, error } = await supabase
    .from('professionals')
    .select('*')
    .eq('id', professionalId)
    .maybeSingle();
  if (error) throw error;
  if (!professional) return null;

  const [profileRes, documentsRes, skillsRes] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', professional.profile_id).maybeSingle(),
    supabase
      .from('professional_documents')
      .select('*')
      .eq('professional_id', professionalId)
      .order('created_at', { ascending: true }),
    supabase
      .from('professional_skills')
      .select('service_id, proficiency')
      .eq('professional_id', professionalId),
  ]);
  if (profileRes.error) throw profileRes.error;
  if (documentsRes.error) throw documentsRes.error;
  if (skillsRes.error) throw skillsRes.error;

  const documents = await Promise.all(
    (documentsRes.data ?? []).map(async (doc): Promise<KycReviewDocument> => {
      const { data, error: signError } = await supabase.storage
        .from('kyc-documents')
        .createSignedUrl(doc.file_path, KYC_SIGNED_URL_TTL_SECONDS);
      return { ...doc, signedUrl: signError ? null : data?.signedUrl ?? null };
    })
  );

  return {
    professional,
    profile: profileRes.data ?? null,
    documents,
    skills: skillsRes.data ?? [],
  };
}

// ── Refunds ──────────────────────────────────────────────────

export interface AdminRefundListItem {
  id: string;
  bookingId: string;
  /** `null` when a refund predates a booking-numbering migration or the row is orphaned. */
  bookingNumber: string | null;
  customerId: string;
  customerName: string;
  amount: number;
  currency: string;
  status: RefundStatus;
  route: Database['public']['Tables']['refunds']['Row']['route'];
  reasonCode: string;
  note: string | null;
  requestedById: string | null;
  requestedByName: string | null;
  processedById: string | null;
  completedAt: string | null;
  requestedAt: string;
}

export interface AdminRefundListFilters {
  status?: RefundStatus;
  /** Booking-number substring. */
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/**
 * The refunds console (§22, §31.1). Money leaves as rupees (the `Numeric`
 * parse happens here), `requested_by`/`processed_by` are profile ids so their
 * names are looked up like every other name in this file, and the `q` filter is
 * a booking-number substring — refunds themselves carry no user-facing number.
 */
export async function listAdminRefunds(
  filters: AdminRefundListFilters,
  supabase: SupabaseClient<Database> = createServerClient()
): Promise<{ refunds: AdminRefundListItem[]; total: number }> {
  const limit = filters.limit ?? 25;
  const offset = filters.offset ?? 0;

  // `q` matches the booking number, which lives on `bookings` — so resolve it
  // to a set of booking ids first. No matching number, no matching refunds.
  let bookingScope: string[] | null = null;
  if (filters.q) {
    const { data: matching, error: scopeError } = await supabase
      .from('bookings')
      .select('id')
      .ilike('booking_number', `%${filters.q}%`)
      .limit(100);
    if (scopeError) throw scopeError;
    bookingScope = (matching ?? []).map((b) => b.id);
    if (bookingScope.length === 0) return { refunds: [], total: 0 };
  }

  let query = supabase.from('refunds').select('*', { count: 'exact' });
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.from) query = query.gte('requested_at', filters.from);
  if (filters.to) query = query.lte('requested_at', filters.to);
  if (bookingScope) query = query.in('booking_id', bookingScope);
  const { data: rows, error, count } = await query
    .order('requested_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const refundRows = rows ?? [];
  if (refundRows.length === 0) return { refunds: [], total: count ?? 0 };

  const [bookingsRes, customersRes, profilesRes] = await Promise.all([
    supabase
      .from('bookings')
      .select('id, booking_number')
      .in('id', [...new Set(refundRows.map((r) => r.booking_id))]),
    supabase
      .from('customers')
      .select('id, profile_id')
      .in('id', [...new Set(refundRows.map((r) => r.customer_id))]),
    supabase
      .from('profiles')
      .select('id, full_name')
      .in(
        'id',
        [...new Set(
          refundRows.flatMap((r) => [r.requested_by, r.processed_by, r.approved_by]).filter((v): v is string => !!v)
        )]
      ),
  ]);
  if (bookingsRes.error) throw bookingsRes.error;
  if (customersRes.error) throw customersRes.error;
  if (profilesRes.error) throw profilesRes.error;

  const bookingByRefund = Object.fromEntries(
    (bookingsRes.data ?? []).map((b) => [b.id, b.booking_number])
  );
  const profileNames = Object.fromEntries(
    (profilesRes.data ?? []).map((p) => [p.id, p.full_name])
  );

  // A flat "customer id → customer id" map is enough to keep the join cheap: we
  // only ever render the customer's *name*, and names live on profiles.
  const customerProfile = Object.fromEntries(
    (customersRes.data ?? []).map((c) => [c.id, c.profile_id])
  );

  return {
    refunds: refundRows.map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      bookingNumber: bookingByRefund[r.booking_id] ?? null,
      customerId: r.customer_id,
      customerName: profileNames[customerProfile[r.customer_id]] ?? 'Customer',
      amount: parseNumeric(r.amount),
      currency: r.currency,
      status: r.status,
      route: r.route,
      reasonCode: r.reason_code,
      note: r.note,
      requestedById: r.requested_by,
      requestedByName: r.requested_by ? profileNames[r.requested_by] ?? null : null,
      processedById: r.processed_by,
      completedAt: r.completed_at,
      requestedAt: r.requested_at,
    })),
    total: count ?? refundRows.length,
  };
}
