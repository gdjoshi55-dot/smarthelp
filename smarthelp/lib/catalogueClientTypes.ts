import type {
  CategorySummary,
  LandingData,
  LocationSummary,
  Serviceability,
  ServiceDetail,
  ServiceSummary,
} from './catalogue';
import type { AvailabilityResult, InstantEstimate, SlotDay } from './availability';

/**
 * The exact payloads the Phase 1 Route Handlers return, in the `{ data }`
 * envelope.
 *
 * These are compositions, not copies: every leaf type is the one the server
 * builds its response with, so a field that changes in `lib/catalogue.ts` or
 * `lib/availability.ts` changes the client's view of it too. That is the whole
 * reason the client is allowed to import from those two modules — both are
 * pure data and functions with no server-only imports in them.
 */

export interface LandingResponse extends LandingData {
  serverNow: string;
}

export interface CatalogueResponse {
  services: ServiceSummary[];
  /** Always present, and `localityId: null` when no location was sent. */
  location: LocationSummary;
  /**
   * What the server actually applied. It defaults to `true` when a location
   * resolved, so the grid can say "hiding 4 services not in your area" without
   * guessing whether the list it was given is complete.
   */
  availableOnly: boolean;
  serverNow: string;
}

export interface CategoriesResponse {
  categories: CategorySummary[];
}

export interface DetailResponse {
  service: ServiceDetail;
  location: LocationSummary;
  serverNow: string;
}

/**
 * `/api/availability`'s payload.
 *
 * The two `location` fields are deliberately different types. The one nested in
 * `AvailabilityResult` is the *resolved* locality and only exists because the
 * route got past the coverage gate; the top-level one is the banner summary and
 * answers for the refused case too, which is why its `localityId` is nullable.
 * They are the same object, widened, so the two are composed rather than
 * redeclared.
 */
export interface AvailabilityResponse
  extends Omit<AvailabilityResult, 'location'> {
  location: LocationSummary;
  serverNow: string;
}

export interface InstantEstimateResponse {
  etaMinutes: number | null;
  prosAvailable: number;
  start: string | null;
  reason: InstantEstimate['reason'] | null;
  /** Always a sentence, so the card has nothing left to invent. */
  etaLabel: string;
  location: LocationSummary;
  /** Absent on the "no locality" answers, where `etaLabel` already says so. */
  serviceable?: Serviceability;
  serverNow: string;
}
