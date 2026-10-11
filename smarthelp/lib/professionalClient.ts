import { readApiError, type ApiErrorCode } from './api';
import { authorizationHeader } from './sessionHeaders';
import type { AvailabilityStatus, VerificationStatus } from './supabase';

/**
 * The browser's half of the Phase 4 professional contract (§25.7).
 *
 * The same transport decisions as `lib/bookingClient.ts`, for the same reason:
 * the session lives in `localStorage`, `requireAuth` reads only the
 * `Authorization` header, and a fetch that forgets it is a 401 that reads as
 * "Please sign in to continue." on a page the user is visibly signed in to.
 * `test/professionalClient.test.ts` exists so a future verb that omits the
 * header is a red test rather than a production 401.
 *
 * Every verb is one function; none of them decides anything about auth, and the
 * header is not a per-verb concern.
 */

export class ProfessionalApiError extends Error {
  constructor(
    message: string,
    readonly code: ApiErrorCode | string,
    readonly status: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ProfessionalApiError';
  }

  get fields(): Record<string, string> | null {
    const fields = this.details?.fields;
    return fields && typeof fields === 'object' ? (fields as Record<string, string>) : null;
  }
}

/**
 * One authenticated call. `authorizationHeader()` is resolved before the try so
 * a missing `NEXT_PUBLIC_*` key reports as a build problem, not a network one —
 * the reasoning is `lib/bookingClient.ts`'s, verbatim.
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
    throw new ProfessionalApiError(
      'We could not reach SmartHelp. Check your connection and try again.',
      'NETWORK_ERROR',
      0
    );
  }

  if (!res.ok) {
    const { message, code, details } = await readApiError(res);
    throw new ProfessionalApiError(message, code, res.status, details);
  }

  const body = (await res.json()) as { data: T };
  return body.data;
}

// ── Types ────────────────────────────────────────────────────

export interface WorkingHour {
  id: string;
  weekday: number;
  startTime: string;
  endTime: string;
  isActive: boolean;
}

export interface WorkingHourInput {
  weekday: number;
  startTime: string;
  endTime: string;
}

export interface TimeOffEntry {
  id: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

export interface AvailabilityState {
  availabilityStatus: AvailabilityStatus;
  isAvailableToday: boolean;
}

export interface KycDocument {
  id: string;
  docType: string;
  filePath: string;
  status: VerificationStatus;
  rejectionReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface KycState {
  verificationStatus: VerificationStatus;
  kycVerifiedAt: string | null;
  documents: KycDocument[];
}

/**
 * A booking as a professional sees it. Money arrives as strings — the columns
 * are `numeric` — and `otp_hash` is never among the fields, by construction.
 */
export interface ProJob {
  id: string;
  booking_number: string;
  status: string;
  booking_type: string;
  version: number;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  duration_minutes: number;
  area?: string | null;
  city?: string | null;
  locality?: string | null;
  address_snapshot?: Record<string, unknown> | null;
  total_amount: string;
  professional_gross?: string;
  currency: string;
  started_at: string | null;
  ends_at: string | null;
  [key: string]: unknown;
}

export interface Offer {
  id: string;
  bookingId: string;
  serviceName: string;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  area: string | null;
  quotedPrice: string;
  expiresAt: string;
}

// ── Availability ─────────────────────────────────────────────

export function fetchWorkingHours(): Promise<{ hours: WorkingHour[] }> {
  return request<{ hours: WorkingHour[] }>('/api/professionals/me/working-hours');
}

export function saveWorkingHours(
  hours: WorkingHourInput[]
): Promise<{ hours: WorkingHour[] }> {
  return request<{ hours: WorkingHour[] }>('/api/professionals/me/working-hours', {
    method: 'PUT',
    body: JSON.stringify({ hours }),
  });
}

export function fetchTimeOff(): Promise<{ timeOff: TimeOffEntry[] }> {
  return request<{ timeOff: TimeOffEntry[] }>('/api/professionals/me/time-off');
}

export function addTimeOff(input: {
  startsAt: string;
  endsAt: string;
  reason?: string | null;
}): Promise<{ timeOff: TimeOffEntry }> {
  return request<{ timeOff: TimeOffEntry }>('/api/professionals/me/time-off', {
    method: 'POST',
    body: JSON.stringify({
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason: input.reason ?? null,
    }),
  });
}

export function deleteTimeOff(id: string): Promise<{ removed: boolean }> {
  return request<{ removed: boolean }>(
    `/api/professionals/me/time-off?entryId=${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  );
}

export function fetchAvailability(): Promise<AvailabilityState> {
  return request<AvailabilityState>('/api/professionals/me/availability');
}

export function setAvailability(online: boolean): Promise<AvailabilityState> {
  return request<AvailabilityState>('/api/professionals/me/availability', {
    method: 'POST',
    body: JSON.stringify({ online }),
  });
}

export function postLocation(input: { lat: number; lng: number }): Promise<{ updated: boolean }> {
  return request<{ updated: boolean }>('/api/professionals/me/location', {
    method: 'POST',
    body: JSON.stringify({ lat: input.lat, lng: input.lng }),
  });
}

// ── KYC ──────────────────────────────────────────────────────

export function fetchKyc(): Promise<KycState> {
  return request<KycState>('/api/professionals/me/kyc');
}

export function submitKycDocument(input: {
  docType: string;
  filePath: string;
}): Promise<{ document: KycDocument }> {
  return request<{ document: KycDocument }>('/api/professionals/me/kyc', {
    method: 'POST',
    body: JSON.stringify({ docType: input.docType, filePath: input.filePath }),
  });
}

/**
 * Ask for a signed upload URL. The path is built server-side from the
 * authenticated professional's id — the browser never names the bucket slot
 * (Pitfall 10) — and the browser then uploads the bytes to `signedUrl`. The
 * declared `contentType` and `size` let the route refuse an oversized or
 * wrong-typed file with a readable message; the bucket's own limits are the
 * backstop.
 */
export function requestKycUploadUrl(input: {
  docType: string;
  filename: string;
  contentType: string;
  size: number;
}): Promise<{ path: string; token: string; signedUrl: string }> {
  return request<{ path: string; token: string; signedUrl: string }>(
    '/api/kyc-documents/upload-url',
    {
      method: 'POST',
      body: JSON.stringify({
        docType: input.docType,
        filename: input.filename,
        contentType: input.contentType,
        size: input.size,
      }),
    }
  );
}

// ── Jobs and offers ──────────────────────────────────────────

/**
 * The live job list, plus the instant the server answered.
 *
 * `serverNow` is not decoration: it is what the job screen's running-service
 * timer anchors on (Interaction Contract 2). `ends_at − serverNow` is computed
 * from two numbers the server produced, so a device with a skewed clock still
 * shows the right remaining minutes — the same reason `fetchOffers` carries it.
 */
export function fetchJobs(): Promise<{ jobs: ProJob[]; serverNow: string }> {
  return request<{ jobs: ProJob[]; serverNow: string }>('/api/professionals/me/jobs');
}

export function fetchOffers(): Promise<{ offers: Offer[]; serverNow: string }> {
  return request<{ offers: Offer[]; serverNow: string }>('/api/professionals/offers');
}

export function acceptOffer(id: string): Promise<{ job: ProJob }> {
  return request<{ job: ProJob }>(
    `/api/professionals/offers/${encodeURIComponent(id)}/accept`,
    { method: 'POST' }
  );
}

export function declineOffer(id: string, reason?: string): Promise<{ declined: boolean }> {
  return request<{ declined: boolean }>(
    `/api/professionals/offers/${encodeURIComponent(id)}/decline`,
    { method: 'POST', body: JSON.stringify({ reason: reason ?? null }) }
  );
}

export function startJourney(id: string): Promise<{ job: ProJob }> {
  return request<{ job: ProJob }>(
    `/api/professionals/jobs/${encodeURIComponent(id)}/on-the-way`,
    { method: 'POST' }
  );
}

export function arriveJob(
  id: string,
  input: { lat: number; lng: number; overrideReason?: string | null }
): Promise<{ job: ProJob }> {
  return request<{ job: ProJob }>(
    `/api/professionals/jobs/${encodeURIComponent(id)}/arrive`,
    {
      method: 'POST',
      body: JSON.stringify({
        lat: input.lat,
        lng: input.lng,
        overrideReason: input.overrideReason ?? null,
      }),
    }
  );
}

export function verifyServiceOtp(id: string, code: string): Promise<{ job: ProJob }> {
  return request<{ job: ProJob }>(
    `/api/professionals/jobs/${encodeURIComponent(id)}/otp`,
    { method: 'POST', body: JSON.stringify({ code }) }
  );
}

export function completeJob(id: string): Promise<{ job: ProJob }> {
  return request<{ job: ProJob }>(
    `/api/professionals/jobs/${encodeURIComponent(id)}/complete`,
    { method: 'POST' }
  );
}

export function reportNoShow(id: string, reason: string): Promise<{ job: ProJob }> {
  return request<{ job: ProJob }>(
    `/api/professionals/jobs/${encodeURIComponent(id)}/no-show`,
    { method: 'POST', body: JSON.stringify({ reason }) }
  );
}
