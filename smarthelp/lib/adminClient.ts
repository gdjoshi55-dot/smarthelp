import { readApiError, type ApiErrorCode } from './api';
import { authorizationHeader } from './sessionHeaders';
import type { DisputeStatus, SupportTicketPriority, SupportTicketStatus } from './supabase';

// Re-exported so a console screen imports its status vocabulary from the same
// module it imports the calls from, instead of reaching into `./supabase`.
export type { DisputeStatus, SupportTicketPriority, SupportTicketStatus };

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

// ── Refunds ──────────────────────────────────────────────────

export interface AdminRefundListItem {
  id: string;
  bookingId: string;
  bookingNumber: string | null;
  customerId: string;
  customerName: string;
  amount: number;
  currency: string;
  status: string;
  route: string | null;
  reasonCode: string;
  note: string | null;
  requestedById: string | null;
  requestedByName: string | null;
  processedById: string | null;
  completedAt: string | null;
  requestedAt: string;
}

export interface AdminRefundQuery {
  status?: string;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function fetchAdminRefunds(
  query: AdminRefundQuery = {}
): Promise<{ refunds: AdminRefundListItem[]; total: number }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return request(`/api/admin/refunds${qs ? `?${qs}` : ''}`);
}

export function executeAdminRefund(
  id: string,
  input: { note?: string | null } = {}
): Promise<{ refund: Record<string, unknown> }> {
  return request(`/api/admin/refunds/${encodeURIComponent(id)}/execute`, {
    method: 'POST',
    body: JSON.stringify({ note: input.note ?? null }),
  });
}

// ── Pricing rules ────────────────────────────────────────────

export interface PricingRuleRow {
  id: string;
  name: string;
  scope: 'global' | 'category' | 'service';
  category_id: string | null;
  service_id: string | null;
  multiplier: string;
  days_of_week: number[];
  start_minute: number | null;
  end_minute: number | null;
  priority: number;
  valid_from: string | null;
  valid_to: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PricingRulePayload {
  name: string;
  scope: 'global' | 'category' | 'service';
  categoryId?: string | null;
  serviceId?: string | null;
  multiplier: number;
  daysOfWeek?: number[];
  startMinute?: number | null;
  endMinute?: number | null;
  priority?: number;
  validFrom?: string | null;
  validTo?: string | null;
  isActive?: boolean;
}

export function fetchPricingRules(): Promise<{ rules: PricingRuleRow[] }> {
  return request('/api/admin/pricing-rules');
}

export function createPricingRule(input: PricingRulePayload): Promise<{ rule: PricingRuleRow }> {
  return request('/api/admin/pricing-rules', { method: 'POST', body: JSON.stringify(input) });
}

export function updatePricingRule(id: string, input: PricingRulePayload): Promise<{ rule: PricingRuleRow }> {
  return request(`/api/admin/pricing-rules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deletePricingRule(id: string): Promise<{ deleted: true }> {
  return request(`/api/admin/pricing-rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── Cancellation policies ────────────────────────────────────

export interface CancellationPolicyRow {
  id: string;
  service_id: string | null;
  hours_before: string | null;
  fee_type: string;
  fee_value: string;
  applies_when_arrived: boolean;
  band: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CancellationPolicyPayload {
  serviceId?: string | null;
  hoursBefore?: number | null;
  feeType: string;
  feeValue: number;
  appliesWhenArrived?: boolean;
  band?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

export function fetchCancellationPolicies(): Promise<{ policies: CancellationPolicyRow[] }> {
  return request('/api/admin/cancellation-policies');
}

export function createCancellationPolicy(
  input: CancellationPolicyPayload
): Promise<{ policy: CancellationPolicyRow }> {
  return request('/api/admin/cancellation-policies', { method: 'POST', body: JSON.stringify(input) });
}

export function updateCancellationPolicy(
  id: string,
  input: CancellationPolicyPayload
): Promise<{ policy: CancellationPolicyRow }> {
  return request(`/api/admin/cancellation-policies/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteCancellationPolicy(id: string): Promise<{ deleted: true }> {
  return request(`/api/admin/cancellation-policies/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── Coupons ──────────────────────────────────────────────────

export interface AdminCouponListItem {
  id: string;
  code: string;
  description: string | null;
  discountType: string;
  discountValue: number;
  maxDiscount: number | null;
  minBookingAmount: number;
  validFrom: string;
  validTo: string | null;
  usageLimit: number | null;
  usageCount: number;
  perUserLimit: number;
  firstTimeOnly: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface AdminCouponDetail extends AdminCouponListItem {
  maxDiscountPctOfTotal: number;
  applicableServices: string[];
  applicableCities: string[];
  usage: { id: string; customer_id: string; booking_id: string; discount_amount: string; used_at: string }[];
}

export interface AdminCouponPayload {
  code: string;
  description?: string | null;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  maxDiscount?: number | null;
  minBookingAmount?: number;
  maxDiscountPctOfTotal?: number;
  validFrom: string;
  validTo?: string | null;
  usageLimit?: number | null;
  perUserLimit?: number;
  applicableServices?: string[];
  applicableCities?: string[];
  firstTimeOnly?: boolean;
  isActive?: boolean;
}

/** The raw coupon row the create/update routes return. */
export interface AdminCouponRow extends Record<string, unknown> {
  id: string;
  code: string;
}

export function fetchAdminCoupons(
  query: { q?: string; status?: string; limit?: number; offset?: number } = {}
): Promise<{ coupons: AdminCouponListItem[]; total: number }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return request(`/api/admin/coupons${qs ? `?${qs}` : ''}`);
}

export function fetchAdminCoupon(id: string): Promise<{ coupon: AdminCouponDetail }> {
  return request(`/api/admin/coupons/${encodeURIComponent(id)}`);
}

export function createCoupon(input: AdminCouponPayload): Promise<{ coupon: AdminCouponRow }> {
  return request('/api/admin/coupons', { method: 'POST', body: JSON.stringify(input) });
}

export function updateCoupon(id: string, input: AdminCouponPayload): Promise<{ coupon: AdminCouponRow }> {
  return request(`/api/admin/coupons/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

// ── Services / catalogue ─────────────────────────────────────

export interface AdminServiceListItem {
  id: string;
  name: string;
  slug: string;
  categoryId: string;
  categoryName: string;
  pricingType: string;
  basePrice: number;
  durationMin: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminServiceRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string;
  category_id: string;
  base_price: number;
  pricing_type: string;
  is_active: boolean;
}

export interface ServiceDurationRow {
  id: string;
  service_id: string;
  minutes: number;
  price: number | null;
  price_multiplier: number | null;
  is_active: boolean;
}

export interface ServiceAreaRow {
  id: string;
  service_id: string;
  locality_id: string;
  lead_minutes: number;
  slot_capacity: number;
  is_active: boolean;
  created_at: string;
  localityName: string;
}

export interface AdminServiceDetail {
  service: AdminServiceRow;
  categoryName: string;
  durations: ServiceDurationRow[];
  areas: ServiceAreaRow[];
}

export interface AdminServicePayload {
  categoryId: string;
  name: string;
  shortDescription?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  basePrice: number;
  pricingType: 'hourly' | 'flat' | 'per_unit';
  unitLabel?: string | null;
  unitPrice?: number | null;
  minDurationMin?: number;
  maxDurationMin?: number;
  prepMinutes?: number;
  maxActiveJobs?: number;
  materialsIncluded?: boolean;
  materialsNote?: string | null;
  requiresPhotoProof?: boolean;
  sortOrder?: number;
  isActive?: boolean;
  durations?: { minutes: number; price?: number | null; priceMultiplier?: number | null; isActive?: boolean }[];
}

export interface ServiceDurationPayload {
  minutes: number;
  price?: number | null;
  priceMultiplier?: number | null;
  isActive?: boolean;
}

export interface ServiceAreaPayload {
  localityId: string;
  leadMinutes?: number;
  slotCapacity?: number;
  isActive?: boolean;
}

export function fetchAdminServices(
  query: { q?: string; categoryId?: string; isActive?: boolean; limit?: number; offset?: number } = {}
): Promise<{ services: AdminServiceListItem[]; total: number }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return request(`/api/admin/services${qs ? `?${qs}` : ''}`);
}

export function fetchAdminService(id: string): Promise<{ service: AdminServiceDetail }> {
  return request(`/api/admin/services/${encodeURIComponent(id)}`);
}

export function createService(input: AdminServicePayload): Promise<{ service: AdminServiceDetail }> {
  return request('/api/admin/services', { method: 'POST', body: JSON.stringify(input) });
}

export function updateService(id: string, input: AdminServicePayload): Promise<{ service: AdminServiceDetail }> {
  return request(`/api/admin/services/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function createServiceDuration(
  serviceId: string,
  input: ServiceDurationPayload
): Promise<{ duration: ServiceDurationRow }> {
  return request(`/api/admin/services/${encodeURIComponent(serviceId)}/durations`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateServiceDuration(
  serviceId: string,
  durationId: string,
  input: Partial<ServiceDurationPayload>
): Promise<{ duration: ServiceDurationRow }> {
  return request(
    `/api/admin/services/${encodeURIComponent(serviceId)}/durations/${encodeURIComponent(durationId)}`,
    { method: 'PATCH', body: JSON.stringify(input) }
  );
}

export function deleteServiceDuration(serviceId: string, durationId: string): Promise<{ deleted: true }> {
  return request(
    `/api/admin/services/${encodeURIComponent(serviceId)}/durations/${encodeURIComponent(durationId)}`,
    { method: 'DELETE' }
  );
}

export function createServiceArea(
  serviceId: string,
  input: ServiceAreaPayload
): Promise<{ area: ServiceAreaRow }> {
  return request(`/api/admin/services/${encodeURIComponent(serviceId)}/areas`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateServiceArea(
  serviceId: string,
  areaId: string,
  input: Partial<ServiceAreaPayload>
): Promise<{ area: ServiceAreaRow }> {
  return request(
    `/api/admin/services/${encodeURIComponent(serviceId)}/areas/${encodeURIComponent(areaId)}`,
    { method: 'PATCH', body: JSON.stringify(input) }
  );
}

export function deleteServiceArea(serviceId: string, areaId: string): Promise<{ deleted: true }> {
  return request(
    `/api/admin/services/${encodeURIComponent(serviceId)}/areas/${encodeURIComponent(areaId)}`,
    { method: 'DELETE' }
  );
}

export function fetchLocalities(q?: string): Promise<{ localities: { id: string; name: string; city: string }[] }> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  return request(`/api/admin/localities${qs}`);
}

// ── Settings ─────────────────────────────────────────────────

/** The typed settings the API returns; mirrors `PlatformSettings`. */
export interface PlatformSettings {
  currency: string;
  taxRate: number;
  commissionPct: number;
  platformFeePct: number;
  platformFeeMin: number;
  serviceOtpLength: number;
  instantLeadMinutes: number;
  maxBookingMinutes: number;
  maxSchedulingDaysAhead: number;
  instantMatchTargetSeconds: number;
  lateArrivalThresholdMin: number;
  noShowAfterMin: number;
  supportRefundLimit: number;
  offerTtlMinutes: number;
  searchWindowMinutes: number;
  otpTtlMinutes: number;
  otpMaxAttempts: number;
  otpLockoutMinutes: number;
  otpMaxGenerations: number;
  defaultArrivalRadiusM: number;
  proLocationFreshMinutes: number;
  proLocationThrottleSeconds: number;
}

export function fetchPlatformSettings(): Promise<{ settings: PlatformSettings }> {
  return request('/api/admin/settings');
}

export function updatePlatformSettings(
  patch: Partial<PlatformSettings>
): Promise<{ settings: PlatformSettings; updated: string[] }> {
  return request('/api/admin/settings', { method: 'PUT', body: JSON.stringify(patch) });
}

// ── Audit ────────────────────────────────────────────────────

export interface AdminAuditLogItem {
  id: string;
  actorProfileId: string | null;
  actorName: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface AdminAuditQuery {
  action?: string;
  entityType?: string;
  entityId?: string;
  actorProfileId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function fetchAuditLogs(
  query: AdminAuditQuery = {}
): Promise<{ logs: AdminAuditLogItem[]; total: number }> {
  return request(`/api/admin/audit?${queryString(query)}`);
}

// ── Support ──────────────────────────────────────────────────

export interface AdminSupportTicketListItem {
  id: string;
  bookingId: string | null;
  bookingNumber: string | null;
  subject: string;
  category: string;
  priority: SupportTicketPriority;
  status: SupportTicketStatus;
  assignedToId: string | null;
  assignedToName: string | null;
  raisedById: string | null;
  raisedByName: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSupportMessage {
  id: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  isInternal: boolean;
  createdAt: string;
}

export interface AdminSupportTicketDetail {
  ticket: AdminSupportTicketListItem;
  messages: AdminSupportMessage[];
}

export interface AdminSupportQuery {
  status?: SupportTicketStatus;
  priority?: SupportTicketPriority;
  assignedTo?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface AdminSupportTicketPatch {
  status?: SupportTicketStatus;
  priority?: SupportTicketPriority;
  assignedTo?: string | null;
  resolution?: string | null;
}

export function fetchSupportTickets(
  query: AdminSupportQuery = {}
): Promise<{ tickets: AdminSupportTicketListItem[]; total: number }> {
  return request(`/api/admin/support?${queryString(query)}`);
}

export function fetchSupportTicket(id: string): Promise<AdminSupportTicketDetail> {
  return request(`/api/admin/support/${encodeURIComponent(id)}`);
}

export function updateSupportTicket(
  id: string,
  patch: AdminSupportTicketPatch
): Promise<AdminSupportTicketDetail> {
  return request(`/api/admin/support/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function addSupportMessage(
  id: string,
  input: { body: string; isInternal?: boolean }
): Promise<{ message: AdminSupportMessage }> {
  return request(`/api/admin/support/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// ── Disputes ─────────────────────────────────────────────────

export interface AdminDisputeListItem {
  id: string;
  bookingId: string;
  bookingNumber: string | null;
  reason: string;
  description: string | null;
  status: DisputeStatus;
  resolution: string | null;
  raisedById: string | null;
  raisedByName: string | null;
  resolvedById: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminDisputeQuery {
  status?: DisputeStatus;
  q?: string;
  limit?: number;
  offset?: number;
}

export function fetchAdminDisputes(
  query: AdminDisputeQuery = {}
): Promise<{ disputes: AdminDisputeListItem[]; total: number }> {
  return request(`/api/admin/disputes?${queryString(query)}`);
}

export function resolveAdminDispute(
  id: string,
  input: { status: DisputeStatus; resolution?: string | null }
): Promise<{ dispute: AdminDisputeListItem }> {
  return request(`/api/admin/disputes/${encodeURIComponent(id)}/resolve`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

function queryString(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return params.toString();
}
