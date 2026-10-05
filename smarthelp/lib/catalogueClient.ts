import { readApiError } from './api';
import type {
  AvailabilityResponse,
  CatalogueResponse,
  DetailResponse,
  InstantEstimateResponse,
  LandingResponse,
} from './catalogueClientTypes';

/**
 * The browser's half of the Phase 1 contract.
 *
 * Every one of these endpoints answers the same envelope — `{ data }` on success
 * and `{ error, code, details }` on failure — so the fetching, the status check
 * and the error unwrapping live here once instead of in each component. The
 * server never sees a shape the components cannot name: `T` is the response type
 * the corresponding Route Handler returns, imported from the same module the
 * route builds it with.
 *
 * `ApiRequestError` carries the machine-readable `code` and `details` through,
 * because the availability screen branches on them: a 422 with
 * `reason: 'outside_coverage'` is a banner, while a 400 on `duration` is a
 * message under the chip the person just pressed.
 */

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: Record<string, any>
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** The field errors of a VALIDATION_ERROR, if that is what this is. */
  get fields(): Record<string, string> | null {
    const fields = this.details?.fields;
    return fields && typeof fields === 'object' ? (fields as Record<string, string>) : null;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    // A failed fetch is a network problem, not an API answer, and the two need
    // different copy: one is worth retrying, the other is not.
    throw new ApiRequestError(
      'We could not reach SmartHelp. Check your connection and try again.',
      'NETWORK_ERROR',
      0
    );
  }

  if (!res.ok) {
    const { message, code, details } = await readApiError(res);
    throw new ApiRequestError(message, code, res.status, details);
  }

  const body = (await res.json()) as { data: T };
  return body.data;
}

/** The location a page is being viewed from, as query parameters. */
export interface LocationQueryInput {
  /**
   * A saved address.
   *
   * Preferred over the other three when it is known, and the only one that
   * identifies the customer: it is the sole form the server can check ownership
   * against, so a request carrying one gets "this address was not found on your
   * account" rather than a locality anybody could have claimed.
   */
  addressId?: string | null;
  area?: string | null;
  lat?: number | null;
  lng?: number | null;
  city?: string | null;
}

/**
 * Serialises a location into the query string the API reads.
 *
 * The key is `area` for a place that was typed or picked and `lat`/`lng` for a
 * browser fix. Both are sent when both are known: the name is the better match
 * and the point is the fallback, and the server prefers the name — so sending
 * both can only help a locality that has been renamed.
 *
 * `addressId` wins outright when present. The server checks it for ownership and
 * then ignores the rest, so sending an id *and* a stale area would be sending two
 * answers to one question and trusting a copy on the client over the record on
 * the server.
 */
export function locationParams(location?: LocationQueryInput | null): string {
  if (!location) return '';
  const params = new URLSearchParams();
  if (location.addressId) {
    params.set('addressId', location.addressId);
  } else {
    if (location.area) params.set('area', location.area);
    if (location.lat != null && location.lng != null) {
      params.set('lat', String(location.lat));
      params.set('lng', String(location.lng));
    }
  }
  if (location.city) params.set('city', location.city);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function fetchLanding(location?: LocationQueryInput | null): Promise<LandingResponse> {
  return request<LandingResponse>(`/api/landing${locationParams(location)}`);
}

export interface CatalogueQuery extends LocationQueryInput {
  q?: string;
  category?: string;
  availableOnly?: boolean;
}

export function fetchCatalogue(query: CatalogueQuery = {}): Promise<CatalogueResponse> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.category) params.set('category', query.category);
  if (query.availableOnly != null) params.set('availableOnly', String(query.availableOnly));
  if (query.area) params.set('area', query.area);
  if (query.lat != null && query.lng != null) {
    params.set('lat', String(query.lat));
    params.set('lng', String(query.lng));
  }
  const qs = params.toString();
  return request<CatalogueResponse>(`/api/services${qs ? `?${qs}` : ''}`);
}

export function fetchService(
  slug: string,
  location?: LocationQueryInput | null
): Promise<DetailResponse> {
  return request<DetailResponse>(
    `/api/services/${encodeURIComponent(slug)}${locationParams(location)}`
  );
}

export interface AvailabilityQuery extends LocationQueryInput {
  serviceId: string;
  date: string;
  durationMinutes?: number;
}

export function fetchAvailability(query: AvailabilityQuery): Promise<AvailabilityResponse> {
  const params = new URLSearchParams();
  params.set('serviceId', query.serviceId);
  params.set('date', query.date);
  // The wire parameter is `duration`, not `durationMinutes`: the route reads it
  // through `parseAvailabilityQuery` (lib/validation.ts). The field on this
  // object stays `durationMinutes` because that is what the response calls it.
  if (query.durationMinutes) params.set('duration', String(query.durationMinutes));
  if (query.area) params.set('area', query.area);
  if (query.lat != null && query.lng != null) {
    params.set('lat', String(query.lat));
    params.set('lng', String(query.lng));
  }
  return request<AvailabilityResponse>(`/api/availability?${params.toString()}`);
}

export interface EstimateQuery extends LocationQueryInput {
  serviceId: string;
  durationMinutes?: number;
}

export function fetchEstimate(query: EstimateQuery): Promise<InstantEstimateResponse> {
  const params = new URLSearchParams();
  params.set('serviceId', query.serviceId);
  if (query.durationMinutes) params.set('duration', String(query.durationMinutes));
  if (query.area) params.set('area', query.area);
  if (query.lat != null && query.lng != null) {
    params.set('lat', String(query.lat));
    params.set('lng', String(query.lng));
  }
  return request<InstantEstimateResponse>(`/api/availability/estimate?${params.toString()}`);
}
