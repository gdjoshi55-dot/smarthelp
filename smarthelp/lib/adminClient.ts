import { readApiError, type ApiErrorCode } from './api';
import { authorizationHeader } from './sessionHeaders';

/**
 * The browser's half of the Phase 6 admin contract (§20.11–§20.13, §22).
 *
 * The same transport decisions as `lib/professionalClient.ts`: the session lives
 * in `localStorage`, `requireAuth` reads only the `Authorization` header, and a
 * fetch that forgets it is a 401 that reads as "Please sign in" on a page the
 * user is visibly signed in to. `test/adminClient.test.ts` guards that.
 */

export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly code: ApiErrorCode | string,
    readonly status: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AdminApiError';
  }

  get fields(): Record<string, string> | null {
    const fields = this.details?.fields;
    return fields && typeof fields === 'object' ? (fields as Record<string, string>) : null;
  }
}

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
    throw new AdminApiError(
      'We could not reach SmartHelp. Check your connection and try again.',
      'NETWORK_ERROR',
      0
    );
  }

  if (!res.ok) {
    const { message, code, details } = await readApiError(res);
    throw new AdminApiError(message, code, res.status, details);
  }

  const body = (await res.json()) as { data: T };
  return body.data;
}

// ── Types ────────────────────────────────────────────────────

export interface DashboardSummary {
  bookings: {
    today: number;
    completedToday: number;
    cancelledToday: number;
    awaitingProfessional: number;
    inProgress: number;
  };
  gmvToday: number;
  professionals: { total: number; verified: number; online: number; pendingKyc: number };
  refunds: { pendingApproval: number };
}

export interface AdminBookingListItem {
  id: string;
  bookingNumber: string;
  status: string;
  bookingType: string;
  customerName: string | null;
  professionalName: string | null;
  serviceName: string | null;
  totalAmount: number;
  currency: string;
  scheduledStartAt: string | null;
  createdAt: string;
}

/** The raw booking row, as the API returns it; money columns are strings. */
export interface AdminBookingRow {
  id: string;
  booking_number: string;
  status: string;
  booking_type: string;
  customer_id: string;
  professional_id: string | null;
  total_amount: string;
  subtotal: string;
  platform_fee: string;
  discount: string;
  tax: string;
  currency: string;
  scheduled_start_at: string | null;
  created_at: string;
  [key: string]: unknown;
}

export interface AdminBookingDetail {
  booking: AdminBookingRow;
  customer: { id: string; name: string | null } | null;
  professional: { id: string; name: string | null } | null;
  items: { id: string; service_name: string; quantity: number; line_total: string }[];
  history: {
    id: string;
    from_status: string | null;
    to_status: string;
    actor_role: string | null;
    note: string | null;
    created_at: string;
  }[];
  assignments: {
    id: string;
    professional_id: string;
    status: string;
    offered_at: string;
    expires_at: string;
    responded_at: string | null;
  }[];
  payments: { id: string; amount: string; status: string; method: string | null; created_at: string }[];
  refunds: { id: string; amount: string; status: string; reason_code: string; requested_at: string }[];
}

export interface AdminProfessionalListItem {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  employeeCode: string | null;
  verificationStatus: string;
  availabilityStatus: string;
  isAvailableToday: boolean;
  rating: number | null;
  completedJobs: number;
  totalOffers: number;
  acceptedOffers: number;
  createdAt: string;
}

export interface AdminProfessionalDetail {
  professional: {
    id: string;
    profile_id: string;
    employee_code: string | null;
    verification_status: string;
    training_status: string;
    availability_status: string;
    is_available_today: boolean;
    rating: number | null;
    rating_count: number;
    completed_jobs: number;
    cancelled_jobs: number;
    no_shows: number;
    total_offers: number;
    accepted_offers: number;
    experience_months: number;
    commission_pct: number;
    suspended_reason: string | null;
    kyc_verified_at: string | null;
    onboarded_at: string | null;
    created_at: string;
    [key: string]: unknown;
  };
  profile: { full_name: string; phone: string | null; email: string | null } | null;
  documents: {
    id: string;
    doc_type: string;
    status: string;
    file_path: string;
    rejection_reason: string | null;
    reviewed_at: string | null;
    created_at: string;
  }[];
  skills: { service_id: string; proficiency: number }[];
  recentBookings: AdminBookingListItem[];
}

export type KycReviewDocument = AdminProfessionalDetail['documents'][number] & {
  /** Short-lived signed read URL; null when the object is gone. */
  signedUrl: string | null;
};

export interface KycReview {
  professional: AdminProfessionalDetail['professional'];
  profile: AdminProfessionalDetail['profile'];
  documents: KycReviewDocument[];
  skills: { service_id: string; proficiency: number }[];
}

// ── Dashboard ────────────────────────────────────────────────

export function fetchDashboard(): Promise<DashboardSummary> {
  return request<DashboardSummary>('/api/admin/dashboard');
}

// ── Bookings ─────────────────────────────────────────────────

export interface AdminBookingQuery {
  status?: string;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function fetchAdminBookings(
  query: AdminBookingQuery = {}
): Promise<{ bookings: AdminBookingListItem[]; total: number; limit: number; offset: number }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return request(`/api/admin/bookings${qs ? `?${qs}` : ''}`);
}

export function fetchAdminBooking(id: string): Promise<AdminBookingDetail> {
  return request<AdminBookingDetail>(`/api/admin/bookings/${encodeURIComponent(id)}`);
}

export function cancelAdminBooking(
  id: string,
  input: { reasonCode: string; note?: string | null; chargeCustomer?: boolean }
): Promise<{ booking: AdminBookingRow; fee: number; refund: number; waived: boolean; band: string }> {
  return request(`/api/admin/bookings/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({
      reasonCode: input.reasonCode,
      note: input.note ?? null,
      chargeCustomer: input.chargeCustomer ?? false,
    }),
  });
}

export function assignAdminBooking(
  id: string,
  input: { professionalId: string; note?: string | null }
): Promise<{ bookingId: string; professionalId: string; assignmentId: string | null }> {
  return request(`/api/admin/bookings/${encodeURIComponent(id)}/assign`, {
    method: 'POST',
    body: JSON.stringify({ professionalId: input.professionalId, note: input.note ?? null }),
  });
}

// ── Professionals ────────────────────────────────────────────

export interface AdminProfessionalQuery {
  verificationStatus?: string;
  availabilityStatus?: string;
  q?: string;
  pendingKyc?: boolean;
  limit?: number;
  offset?: number;
}

export function fetchAdminProfessionals(
  query: AdminProfessionalQuery = {}
): Promise<{
  professionals: AdminProfessionalListItem[];
  total: number;
  limit: number;
  offset: number;
}> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return request(`/api/admin/professionals${qs ? `?${qs}` : ''}`);
}

export function fetchAdminProfessional(id: string): Promise<AdminProfessionalDetail> {
  return request<AdminProfessionalDetail>(`/api/admin/professionals/${encodeURIComponent(id)}`);
}

export function fetchKycReview(id: string): Promise<KycReview> {
  return request<KycReview>(`/api/admin/professionals/${encodeURIComponent(id)}/kyc`);
}

export function bulkKycDecision(input: {
  professionalIds: string[];
  verdict: 'verified' | 'rejected';
  note?: string | null;
}): Promise<{
  verdict: 'verified' | 'rejected';
  results: { professionalId: string; verificationStatus: string | null; documentsProcessed: number }[];
}> {
  return request('/api/admin/professionals/kyc/bulk-decision', {
    method: 'POST',
    body: JSON.stringify({
      professionalIds: input.professionalIds,
      verdict: input.verdict,
      note: input.note ?? null,
    }),
  });
}

export function kycDocumentDecision(
  professionalId: string,
  documentId: string,
  input: { verdict: 'verified' | 'rejected'; note?: string | null }
): Promise<{ verificationStatus: string }> {
  return request(
    `/api/admin/professionals/${encodeURIComponent(professionalId)}/kyc/${encodeURIComponent(
      documentId
    )}/decision`,
    {
      method: 'POST',
      body: JSON.stringify({ verdict: input.verdict, note: input.note ?? null }),
    }
  );
}

export function setProfessionalSuspended(
  id: string,
  input: { suspended: boolean; reason?: string | null }
): Promise<{ professionalId: string; suspended: boolean; profileStatus: string }> {
  return request(`/api/admin/professionals/${encodeURIComponent(id)}/suspend`, {
    method: 'POST',
    body: JSON.stringify({ suspended: input.suspended, reason: input.reason ?? null }),
  });
}
