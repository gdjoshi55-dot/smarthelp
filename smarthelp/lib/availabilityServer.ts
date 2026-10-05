import { createServerClient } from './supabaseServer';
import { ApiHttpError } from './api';
import { PLATFORM_DEFAULTS, SLOT_GRANULARITY_MIN } from './constants';
import {
  computeSlots,
  estimateInstant,
  wallClockToInstant,
  zoneDate,
  type AvailabilityResult,
  type BusyWindow,
  type DailyWindow,
  type InstantEstimate,
  type ProfessionalAvailability,
  type SlotDay,
} from './availability';
import type { Serviceability } from './catalogue';

// The response contract lives in `./availability`, which the browser can import;
// re-exported here so the server modules keep importing it from beside the code
// that fills it in.
export type { AvailabilityResult };

/**
 * The availability read model (Phase 1).
 *
 * `lib/availability.ts` decides what the slots are; this gathers the rows that
 * decision is made from. The split is deliberate: the algorithm is where the
 * bugs live, so it is a pure function with a clock it is handed, and this file
 * is the boring part that can be replaced when the shape of the data changes.
 *
 * The inputs, from §9.1, and where each one comes from:
 *
 *   locality              resolved from the address / point / area
 *   service area          `service_areas` — an inactive row means SERVICE_UNAVAILABLE
 *   lead time             max(area.lead_minutes, service.prep_minutes) and, for today,
 *                         `platform_defaults.instantLeadMinutes`
 *   duration              bounded by the service and by `service_durations`
 *   working hours         `professional_working_hours`, per professional
 *   time off              `professional_time_off` overlapping the day
 *   live supply           verified + trained + online professionals holding the skill
 *   capacity              `service_areas.slot_capacity`, and `max_active_jobs` in Phase 5
 *
 * The one §9.1 input not wired here is "not already reserved", because
 * `professional_schedule` arrives with `bookings` in Phase 2.
 */

const MINUTES_PER_DAY = 1440;

interface GatheredService {
  id: string;
  name: string;
  slug: string;
  prepMinutes: number;
  minDurationMinutes: number;
  maxDurationMinutes: number;
  durations: number[];
}

async function gatherService(serviceId: string): Promise<GatheredService | null> {
  const supabase = createServerClient();

  const { data: service, error } = await supabase
    .from('services')
    .select('id, name, slug, prep_minutes, min_duration_min, max_duration_min')
    .eq('id', serviceId)
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw error;
  if (!service) return null;

  const { data: options, error: optionsError } = await supabase
    .from('service_durations')
    .select('minutes')
    .eq('service_id', serviceId)
    .eq('is_active', true)
    .order('minutes');

  if (optionsError) throw optionsError;

  return {
    id: service.id,
    name: service.name,
    slug: service.slug,
    prepMinutes: service.prep_minutes,
    minDurationMinutes: service.min_duration_min,
    maxDurationMinutes: service.max_duration_min,
    durations: (options ?? []).map((o) => o.minutes),
  };
}

/**
 * The duration a request asked for, checked against what the service allows.
 *
 * Two bounds, not one. `service_durations` is what the customer is *offered* —
 * it is the ladder an admin curated, and a duration that is not on it has no
 * price row behind it. `min_duration_min` / `max_duration_min` are the
 * structural bounds. A request outside either is refused with the list of
 * options rather than a generic message, because "60 min is not available" is
 * only useful next to the minutes that are.
 */
export function resolveDuration(
  service: Pick<
    GatheredService,
    'name' | 'minDurationMinutes' | 'maxDurationMinutes' | 'durations'
  >,
  requested?: number
): number {
  const allowed =
    service.durations.length > 0
      ? service.durations.filter(
          (d) => d >= service.minDurationMinutes && d <= service.maxDurationMinutes
        )
      : null;

  if (requested === undefined) {
    return allowed?.[0] ?? service.minDurationMinutes;
  }

  if (requested < service.minDurationMinutes || requested > service.maxDurationMinutes) {
    throw new ApiHttpError(
      'VALIDATION_ERROR',
      `${service.name} runs for ${service.minDurationMinutes}–${service.maxDurationMinutes} minutes.`,
      400,
      { fields: { duration: 'Outside the allowed range for this service' } }
    );
  }

  if (allowed && !allowed.includes(requested)) {
    throw new ApiHttpError(
      'VALIDATION_ERROR',
      `Choose one of the available durations for ${service.name}.`,
      400,
      { fields: { duration: `Available: ${allowed.join(', ')} minutes` } }
    );
  }

  return requested;
}

/** Verified, trained, online and holding the skill. That is the live supply. */
async function gatherProfessionals(
  serviceId: string,
  timeZone: string,
  date: string,
  onlyProfessionalId?: string
): Promise<ProfessionalAvailability[]> {
  const supabase = createServerClient();

  let skillQuery = supabase
    .from('professional_skills')
    .select('professional_id')
    .eq('service_id', serviceId);
  if (onlyProfessionalId) skillQuery = skillQuery.eq('professional_id', onlyProfessionalId);

  const { data: skills, error: skillsError } = await skillQuery;
  if (skillsError) throw skillsError;

  const ids = [...new Set((skills ?? []).map((s) => s.professional_id))];
  if (ids.length === 0) return [];

  let proQuery = supabase
    .from('professionals')
    .select('id, training_status, availability_status')
    .eq('verification_status', 'verified')
    .in('availability_status', ['online', 'busy'])
    .in('training_status', ['completed']);
  if (onlyProfessionalId) proQuery = proQuery.eq('id', onlyProfessionalId);

  const [proRes, hoursRes] = await Promise.all([
    proQuery,
    supabase.from('professional_working_hours').select('professional_id, weekday, start_time, end_time').in('professional_id', ids),
  ]);

  if (proRes.error) throw proRes.error;
  if (hoursRes.error) throw hoursRes.error;

  const liveIds = new Set((proRes.data ?? []).map((p) => p.id));
  const eligible = ids.filter((id) => liveIds.has(id));
  if (eligible.length === 0) return [];

  const dayStart = wallClockToInstant(date, 0, timeZone).toISOString();
  const dayEnd = wallClockToInstant(date, MINUTES_PER_DAY, timeZone).toISOString();

  const { data: timeOff, error: timeOffError } = await supabase
    .from('professional_time_off')
    .select('professional_id, starts_at, ends_at')
    .in('professional_id', eligible)
    .lt('starts_at', dayEnd)
    .gt('ends_at', dayStart);

  if (timeOffError) throw timeOffError;

  const busyByPro = new Map<string, BusyWindow[]>();
  for (const row of timeOff ?? []) {
    const list = busyByPro.get(row.professional_id) ?? [];
    list.push({ startsAt: row.starts_at, endsAt: row.ends_at });
    busyByPro.set(row.professional_id, list);
  }

  const windowsByPro = new Map<string, DailyWindow[]>();
  for (const row of hoursRes.data ?? []) {
    if (!liveIds.has(row.professional_id)) continue;
    const list = windowsByPro.get(row.professional_id) ?? [];
    list.push({
      weekday: row.weekday,
      startMinute: minutesOfDay(row.start_time),
      endMinute: minutesOfDay(row.end_time),
    });
    windowsByPro.set(row.professional_id, list);
  }

  return eligible.map((id) => ({
    id,
    windows: windowsByPro.get(id) ?? [],
    busy: busyByPro.get(id) ?? [],
  }));
}

/**
 * `time` columns come back as `HH:MM:SS`, and as a `Date`-shaped string in some
 * drivers. Both reduce to minutes from midnight.
 */
function minutesOfDay(value: string): number {
  const [h, m] = String(value).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * §5.3's gate, as one indexed read.
 *
 * An inactive or absent `service_areas` row is what "we do not serve this
 * service at this locality" means. It is checked here rather than in the
 * catalogue read model because availability is the only caller that has to fail
 * on it, and this avoids loading the whole catalogue to answer it.
 */
export async function resolveServiceability(
  serviceId: string,
  locality: { id: string; name: string; cityName: string | null; timeZone: string }
): Promise<Serviceability> {
  const supabase = createServerClient();

  const { data, error } = await supabase
    .from('service_areas')
    .select('locality_id, service_id, lead_minutes, slot_capacity, is_active')
    .eq('locality_id', locality.id)
    .eq('service_id', serviceId)
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    return {
      ok: false,
      localityId: locality.id,
      localityName: locality.name,
      cityName: locality.cityName,
      timeZone: locality.timeZone,
      leadMinutes: 0,
      slotCapacity: 0,
      reason: 'service_not_offered',
      matchedBy: 'area',
    };
  }

  return {
    ok: true,
    localityId: locality.id,
    localityName: locality.name,
    cityName: locality.cityName,
    timeZone: locality.timeZone,
    leadMinutes: data.lead_minutes,
    slotCapacity: data.slot_capacity,
    reason: null,
    matchedBy: 'area',
  };
}

export interface AvailabilityRequest {
  serviceId: string;
  serviceable: Serviceability;
  /** `YYYY-MM-DD` in the city's zone. Defaults to today there. */
  date?: string;
  duration?: number;
  professionalId?: string;
}

/**
 * The whole derivation for one day.
 *
 * `serviceable.ok === false` is a 422 here rather than an empty list: the
 * service is not offered at that locality at all, and an empty slot list would
 * read as "fully booked", which sends the customer looking for a busy calendar
 * that does not exist.
 */
export async function getAvailability(input: AvailabilityRequest): Promise<AvailabilityResult> {
  const service = await gatherService(input.serviceId);
  if (!service) {
    throw new ApiHttpError('NOT_FOUND', 'That service is no longer available.', 404);
  }

  if (!input.serviceable.ok) {
    const where = input.serviceable.localityName;
    throw new ApiHttpError(
      'SERVICE_UNAVAILABLE',
      input.serviceable.reason === 'service_not_offered'
        ? `${service.name} is not offered in ${where} yet.`
        : `We do not serve ${where} yet.`,
      422,
      { locality: where, reason: input.serviceable.reason }
    );
  }

  const durationMinutes = resolveDuration(service, input.duration);
  const timeZone = input.serviceable.timeZone;
  const date = input.date ?? zoneDate(new Date(), timeZone);

  const professionals = await gatherProfessionals(
    service.id,
    timeZone,
    date,
    input.professionalId
  );

  // An instant booking cannot start sooner than the platform lead either, so
  // today's first slot is pushed out by whichever is larger.
  const isToday = date === zoneDate(new Date(), timeZone);
  const leadMinutes =
    Math.max(input.serviceable.leadMinutes, service.prepMinutes) +
    (isToday ? PLATFORM_DEFAULTS.instantLeadMinutes : 0);

  const day = computeSlots({
    date,
    timeZone,
    durationMinutes,
    leadMinutes,
    capacity: input.serviceable.slotCapacity,
    professionals,
    now: new Date(),
    granularityMinutes: SLOT_GRANULARITY_MIN,
  });

  return {
    service: {
      id: service.id,
      name: service.name,
      slug: service.slug,
      minDurationMinutes: service.minDurationMinutes,
      maxDurationMinutes: service.maxDurationMinutes,
    },
    location: {
      localityId: input.serviceable.localityId,
      localityName: input.serviceable.localityName,
      timeZone,
    },
    durationMinutes,
    validDurations:
      service.durations.length > 0
        ? service.durations.filter(
            (d) => d >= service.minDurationMinutes && d <= service.maxDurationMinutes
          )
        : [service.minDurationMinutes, service.maxDurationMinutes],
    serviceable: input.serviceable,
    day,
  };
}

/** "As soon as possible", for the instant-booking card. */
export async function getInstantEstimate(
  serviceId: string,
  serviceable: Serviceability,
  durationMinutes?: number
): Promise<InstantEstimate> {
  const result = await getAvailability({ serviceId, serviceable, duration: durationMinutes });
  return estimateInstant(result.day, new Date());
}
