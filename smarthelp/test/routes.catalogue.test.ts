import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';
import { GET as landing } from '@/app/api/landing/route';
import { GET as categories } from '@/app/api/service-categories/route';
import { GET as services } from '@/app/api/services/route';
import { GET as serviceBySlug } from '@/app/api/services/[slug]/route';
import { GET as availability } from '@/app/api/availability/route';
import { GET as estimate } from '@/app/api/availability/estimate/route';

/**
 * The public catalogue and availability endpoints (§20.1, §20.2, §27.4).
 *
 * These are the routes an anonymous visitor hits before they have an account,
 * so two things are worth asserting above "it returned 200": that a location
 * actually changes the answer, and that the two ways of saying "not available"
 * stay distinct. A busy calendar and an uncovered locality look identical as an
 * empty array, and the whole of Phase 1's exit criterion depends on telling them
 * apart.
 */

const USER_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'test-token';
const CITY_ID = '11111111-0000-4000-8000-000000000001';
const LOCALITY_ID = '5c1a0f0e-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_LOCALITY_ID = '5c1a0f0e-2222-4222-8222-bbbbbbbbbbbb';
const CLEANING = 'a0000000-0000-4000-8000-000000000001';
const PLUMBING = 'a0000000-0000-4000-8000-000000000002';
const DEEP_CLEAN = 'b0000000-0000-4000-8000-000000000001';
const BATHROOM = 'b0000000-0000-4000-8000-000000000002';
const PRO_ID = '77777777-7777-4777-8777-777777777777';
const ADDRESS_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
/** Far enough ahead that no slot is ever held back by the lead time. */
const DATE = '2099-04-15';

let fake: FakeSupabase;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

const CITY = {
  id: CITY_ID,
  name: 'Bengaluru',
  state: 'Karnataka',
  time_zone: 'Asia/Kolkata',
  is_active: true,
};

const LOCALITY = {
  id: LOCALITY_ID,
  city_id: CITY.id,
  name: 'Indiranagar',
  lat: 12.9784,
  lng: 77.6408,
  radius_km: 5,
  is_active: true,
};

const OTHER_LOCALITY = {
  id: OTHER_LOCALITY_ID,
  city_id: CITY.id,
  name: 'Yelahanka',
  lat: 13.1007,
  lng: 77.5963,
  radius_km: 6,
  is_active: true,
};

const CATEGORY = {
  id: CLEANING,
  name: 'Cleaning',
  slug: 'cleaning',
  icon_key: 'spray-can',
  image_url: null,
  sort_order: 1,
  is_active: true,
};

const PLUMBING_CATEGORY = {
  id: PLUMBING,
  name: 'Plumbing',
  slug: 'plumbing',
  icon_key: 'wrench',
  image_url: null,
  sort_order: 2,
  is_active: true,
};

function service(overrides: Record<string, unknown> = {}) {
  return {
    id: DEEP_CLEAN,
    category_id: CLEANING,
    name: 'Deep Cleaning',
    slug: 'deep-cleaning',
    short_description: 'A thorough clean for the whole home.',
    description: 'We clean the kitchen, the bathrooms and every floor in between.',
    image_url: 'https://cdn.smarthelp.test/deep-clean.jpg',
    base_price: 349,
    pricing_type: 'hourly',
    unit_label: 'hour',
    unit_price: 349,
    min_duration_min: 60,
    max_duration_min: 240,
    prep_minutes: 30,
    max_active_jobs: 3,
    materials_included: false,
    materials_note: null,
    requires_photo_proof: false,
    sort_order: 1,
    is_active: true,
    ...overrides,
  };
}

/** A second service, deliberately not offered in Indiranagar. */
const BATHROOM_SERVICE = service({
  id: BATHROOM,
  category_id: PLUMBING,
  name: 'Bathroom Deep Clean',
  slug: 'bathroom-deep-clean',
  short_description: 'Tiles, taps and drains.',
  sort_order: 2,
});

const PROFESSIONAL = {
  id: PRO_ID,
  verification_status: 'verified',
  training_status: 'completed',
  availability_status: 'online',
  rating: 4.7,
  rating_count: 30,
};

/** Only Indiranagar offers the deep clean; that asymmetry is the test fixture. */
const AREA_COVERED = {
  locality_id: LOCALITY_ID,
  service_id: DEEP_CLEAN,
  lead_minutes: 120,
  slot_capacity: 4,
  is_active: true,
};

const AREA_ELSEWHERE = {
  locality_id: OTHER_LOCALITY_ID,
  service_id: DEEP_CLEAN,
  lead_minutes: 120,
  slot_capacity: 4,
  is_active: true,
};

function build(overrides: Partial<ConstructorParameters<typeof FakeSupabase>[0]> = {}) {
  return new FakeSupabase(
    {
      cities: () => ({ data: [CITY], error: null }),
      localities: () => ({ data: [LOCALITY, OTHER_LOCALITY], error: null }),
      service_categories: () => ({ data: [CATEGORY, PLUMBING_CATEGORY], error: null }),
      services: () => ({ data: [service(), BATHROOM_SERVICE], error: null }),
      service_durations: () => ({
        data: [
          { service_id: DEEP_CLEAN, minutes: 60, price: 349, price_multiplier: null, is_active: true },
          { service_id: DEEP_CLEAN, minutes: 120, price: 598, price_multiplier: null, is_active: true },
          { service_id: BATHROOM, minutes: 60, price: 499, price_multiplier: null, is_active: true },
        ],
        error: null,
      }),
      service_areas: () => ({ data: [AREA_COVERED, AREA_ELSEWHERE], error: null }),
      professional_skills: () => ({
        data: [
          { professional_id: PRO_ID, service_id: DEEP_CLEAN },
          { professional_id: PRO_ID, service_id: BATHROOM },
        ],
        error: null,
      }),
      professionals: () => ({ data: [PROFESSIONAL], error: null }),
      professional_working_hours: () => ({
        data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          professional_id: PRO_ID,
          weekday,
          start_time: '09:00:00',
          end_time: '18:00:00',
        })),
        error: null,
      }),
      professional_time_off: () => ({ data: [], error: null }),
      service_tasks: () => ({
        data: [
          { id: 't1', service_id: DEEP_CLEAN, kind: 'included', label: 'Kitchen', sort_order: 1 },
          { id: 't2', service_id: DEEP_CLEAN, kind: 'excluded', label: 'Carpets', sort_order: 2 },
        ],
        error: null,
      }),
      service_images: () => ({ data: [], error: null }),
      service_keywords: () => ({
        data: [{ service_id: DEEP_CLEAN, keyword: 'sofa' }],
        error: null,
      }),
      ...overrides,
    },
    { write_audit: () => ({ data: null, error: null }) }
  );
}

function get(url: string, token?: string): Request {
  return new Request(`http://localhost${url}`, {
    method: 'GET',
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
}

beforeEach(() => {
  fake = build();
});

const body = async (res: Response) => (await res.json()) as any;

// ── /api/service-categories ─────────────────────────────────

describe('GET /api/service-categories', () => {
  it('answers anonymously with the pills and their counts', async () => {
    const res = await categories(get('/api/service-categories'));
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.categories).toHaveLength(2);
    expect(json.data.categories[0]).toMatchObject({
      slug: 'cleaning',
      serviceCount: 1,
    });
  });
});

// ── /api/services ───────────────────────────────────────────

describe('GET /api/services', () => {
  it('answers anonymously, with no location attached, when none was given', async () => {
    const res = await services(get('/api/services'));
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.services).toHaveLength(2);
    // "Available where?" is a question the client asks; the server must not
    // answer it on the client's behalf.
    expect(json.data.services[0].serviceable).toBeNull();
    expect(json.data.location.localityName).toBeNull();
  });

  it('resolves a typed area and says the service is offered there', async () => {
    const res = await services(get('/api/services?area=Indiranagar'));
    const json = await body(res);
    expect(json.data.location).toMatchObject({
      localityName: 'Indiranagar',
      cityName: 'Bengaluru',
      timeZone: 'Asia/Kolkata',
      matchedBy: 'area',
    });
    const deep = json.data.services.find((s: any) => s.id === DEEP_CLEAN);
    expect(deep.serviceable).toMatchObject({ ok: true, leadMinutes: 120, slotCapacity: 4 });
  });

  it('takes the lead time as the larger of the area and the service prep', async () => {
    fake = build({
      service_areas: () => ({
        data: [{ ...AREA_COVERED, lead_minutes: 15 }, AREA_ELSEWHERE],
        error: null,
      }),
    });
    const json = await body(await services(get('/api/services?area=Indiranagar')));
    const deep = json.data.services.find((s: any) => s.id === DEEP_CLEAN);
    // 15 minutes from the area, 30 minutes of prep from the service: 30 wins.
    expect(deep.serviceable.leadMinutes).toBe(30);
  });

  it('hides services the locality does not offer, and can show them with a reason', async () => {
    const hidden = await body(await services(get('/api/services?area=Indiranagar')));
    // Indiranagar has no service_areas row for the bathroom clean.
    expect(hidden.data.services.map((s: any) => s.id)).toEqual([DEEP_CLEAN]);
    expect(hidden.data.availableOnly).toBe(true);

    const shown = await body(
      await services(get('/api/services?area=Indiranagar&availableOnly=false'))
    );
    expect(shown.data.services).toHaveLength(2);
    const bathroom = shown.data.services.find((s: any) => s.id === BATHROOM);
    expect(bathroom.serviceable).toMatchObject({ ok: false, reason: 'service_not_offered' });
  });

  it('refuses half a coordinate pair', async () => {
    const res = await services(get('/api/services?lat=12.97'));
    const json = await body(res);
    expect(res.status).toBe(400);
    expect(json.code).toBe('VALIDATION_ERROR');
    expect(json.details.fields.lng).toBeTruthy();
  });

  it('filters by category slug', async () => {
    const json = await body(await services(get('/api/services?category=plumbing')));
    expect(json.data.services.map((s: any) => s.id)).toEqual([BATHROOM]);
  });

  it('searches the name, the description and the keywords', async () => {
    const byKeyword = await body(await services(get('/api/services?q=sofa')));
    expect(byKeyword.data.services.map((s: any) => s.id)).toEqual([DEEP_CLEAN]);

    const byName = await body(await services(get('/api/services?q=bathroom')));
    expect(byName.data.services.map((s: any) => s.id)).toEqual([BATHROOM]);

    const nothing = await body(await services(get('/api/services?q=astronaut')));
    expect(nothing.data.services).toEqual([]);
  });
});

// ── /api/services/[slug] ────────────────────────────────────

describe('GET /api/services/[slug]', () => {
  it('returns the detail, with the scope contract split by kind', async () => {
    const res = await serviceBySlug(get('/api/services/deep-cleaning?area=Indiranagar'), {
      params: { slug: 'deep-cleaning' },
    });
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.service.slug).toBe('deep-cleaning');
    expect(json.data.service.tasks).toEqual([
      { kind: 'included', label: 'Kitchen', sortOrder: 1 },
      { kind: 'excluded', label: 'Carpets', sortOrder: 2 },
    ]);
    expect(json.data.service.durationOptions).toEqual([
      { minutes: 60, price: 349, priceMultiplier: null },
      { minutes: 120, price: 598, priceMultiplier: null },
    ]);
    expect(json.data.service.serviceable.ok).toBe(true);
  });

  it('404s a service that is not there', async () => {
    const res = await serviceBySlug(get('/api/services/nope'), { params: { slug: 'nope' } });
    expect(res.status).toBe(404);
    expect((await body(res)).code).toBe('NOT_FOUND');
  });

  it('404s rather than 500s when the slug is missing entirely', async () => {
    const res = await serviceBySlug(get('/api/services/'), { params: { slug: '' } });
    expect(res.status).toBe(404);
  });
});

// ── /api/availability ───────────────────────────────────────

describe('GET /api/availability', () => {
  it('returns the day, with the professional count and the ladder', async () => {
    const res = await availability(
      get(`/api/availability?serviceId=${DEEP_CLEAN}&area=Indiranagar&date=${DATE}`)
    );
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.day.date).toBe(DATE);
    expect(json.data.day.timeZone).toBe('Asia/Kolkata');
    expect(json.data.location.timeZone).toBe('Asia/Kolkata');
    expect(json.data.durationMinutes).toBe(60);
    expect(json.data.validDurations).toEqual([60, 120]);
    expect(json.data.day.slots[0]).toMatchObject({ label: '09:00', bookable: true, remaining: 1 });
    expect(json.data.day.slots.at(-1).label).toBe('17:00');
    expect(json.data.serverNow).toBeTruthy();
  });

  it('honours the duration it was asked for', async () => {
    const json = await body(
      await availability(
        get(`/api/availability?serviceId=${DEEP_CLEAN}&area=Indiranagar&date=${DATE}&duration=120`)
      )
    );
    expect(json.data.durationMinutes).toBe(120);
    // A two-hour job stops an hour earlier than a one-hour job.
    expect(json.data.day.slots.at(-1).label).toBe('16:00');
  });

  it('refuses a duration that is not on the ladder, and lists the ones that are', async () => {
    const res = await availability(
      get(`/api/availability?serviceId=${DEEP_CLEAN}&area=Indiranagar&date=${DATE}&duration=90`)
    );
    const json = await body(res);
    expect(res.status).toBe(400);
    expect(json.code).toBe('VALIDATION_ERROR');
    expect(json.details.fields.duration).toContain('60, 120');
  });

  it('refuses a duration the service cannot run at all', async () => {
    const res = await availability(
      get(`/api/availability?serviceId=${DEEP_CLEAN}&area=Indiranagar&date=${DATE}&duration=30`)
    );
    const json = await body(res);
    expect(res.status).toBe(400);
    expect(json.error).toContain('60–240');
  });

  it('422s when the locality is not covered for this service', async () => {
    // Yelahanka serves the deep clean, the bathroom clean nowhere: the answer
    // must be a refusal with a reason, not an empty day.
    const res = await availability(
      get(`/api/availability?serviceId=${BATHROOM}&area=Yelahanka&date=${DATE}`)
    );
    const json = await body(res);
    expect(res.status).toBe(422);
    expect(json.code).toBe('SERVICE_UNAVAILABLE');
    expect(json.details.reason).toBe('service_not_offered');
    expect(json.error).toContain('Yelahanka');
  });

  it('refuses a location we do not serve, and says so in one sentence', async () => {
    const res = await availability(
      get(`/api/availability?serviceId=${DEEP_CLEAN}&area=Atlantis&date=${DATE}`)
    );
    const json = await body(res);
    expect(res.status).toBe(422);
    expect(json.code).toBe('VALIDATION_ERROR');
    expect(json.error).toMatch(/not one we serve/i);
    expect(json.details.reason).toBe('outside_coverage');
    expect(json.details.location.localityName).toBeNull();
    // The banner is still answered, because the client has to say something.
    expect(json.details.location.message).toBeTruthy();
  });

  it('insists on a location', async () => {
    const res = await availability(get(`/api/availability?serviceId=${DEEP_CLEAN}`));
    expect(res.status).toBe(400);
    expect((await body(res)).details.fields.location).toBeTruthy();
  });

  it('refuses a date in the past instead of returning a day of nothing', async () => {
    const res = await availability(
      get(`/api/availability?serviceId=${DEEP_CLEAN}&area=Indiranagar&date=2020-01-01`)
    );
    const json = await body(res);
    expect(res.status).toBe(400);
    expect(json.details.fields.date).toBeTruthy();
  });

  it('refuses a malformed date rather than guessing at it', async () => {
    const res = await availability(
      get(`/api/availability?serviceId=${DEEP_CLEAN}&area=Indiranagar&date=2026-02-31`)
    );
    expect(res.status).toBe(400);
  });

  it('demands a session for an addressId, before it looks anything up', async () => {
    const res = await availability(
      get(`/api/availability?serviceId=${DEEP_CLEAN}&addressId=99999999-9999-4999-8999-999999999999`)
    );
    const json = await body(res);
    expect(res.status).toBe(401);
    expect(json.code).toBe('UNAUTHENTICATED');
    expect(fake.calls.some((c) => c.table === 'addresses')).toBe(false);
  });

  it('refuses an address belonging to somebody else, and does not say whose', async () => {
    fake = build({
      profiles: () => ({
        data: { id: USER_ID, role: 'customer', status: 'active', full_name: 'Asha Rao' },
        error: null,
      }),
      customers: () => ({ data: { id: 'cust-1' }, error: null }),
      addresses: () => ({ data: [], error: null }),
    });
    const res = await availability(
      get(`/api/availability?serviceId=${DEEP_CLEAN}&addressId=${ADDRESS_ID}`, TOKEN)
    );
    const json = await body(res);
    expect(res.status).toBe(404);
    expect(json.code).toBe('NOT_FOUND');
    // "Not yours" and "not there" have to be the same answer, or the endpoint
    // becomes a way to find out which address ids exist.
    expect(json.error).not.toMatch(/belong|owner|another/i);
  });
});

// ── /api/availability/estimate ──────────────────────────────

describe('GET /api/availability/estimate', () => {
  it('answers with minutes from now and a sentence to put on the card', async () => {
    const res = await estimate(
      get(`/api/availability/estimate?serviceId=${DEEP_CLEAN}&area=Indiranagar`)
    );
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.etaLabel).toMatch(/^(in \d+ (min|hr( \d+ min)?)|No slots today)$/);
    if (json.data.etaMinutes !== null) {
      expect(json.data.etaMinutes).toBeGreaterThanOrEqual(0);
      expect(json.data.prosAvailable).toBe(1);
    }
  });

  it('answers null rather than failing when nothing is free today', async () => {
    fake = build({
      professional_working_hours: () => ({
        data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          professional_id: PRO_ID,
          weekday,
          start_time: '00:00:00',
          end_time: '00:00:01',
        })),
        error: null,
      }),
    });
    const json = await body(
      await estimate(get(`/api/availability/estimate?serviceId=${DEEP_CLEAN}&area=Indiranagar`))
    );
    expect(json.data.etaMinutes).toBeNull();
    expect(json.data.etaLabel).toBe('No slots today');
  });

  it('says the service is not offered there instead of quoting a time', async () => {
    const json = await body(
      await estimate(get(`/api/availability/estimate?serviceId=${BATHROOM}&area=Indiranagar`))
    );
    expect(json.data.etaMinutes).toBeNull();
    expect(json.data.etaLabel).toBe('Not offered in Indiranagar');
    expect(json.data.serviceable.ok).toBe(false);
  });

  it('needs a serviceId and a location', async () => {
    expect((await estimate(get('/api/availability/estimate?area=Indiranagar'))).status).toBe(400);
    expect((await estimate(get(`/api/availability/estimate?serviceId=${DEEP_CLEAN}`))).status).toBe(
      400
    );
  });
});

// ── /api/landing ────────────────────────────────────────────

describe('GET /api/landing', () => {
  it('answers anonymously with everything the page renders', async () => {
    const res = await landing(get('/api/landing'));
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.categories).toHaveLength(2);
    expect(json.data.featured.length).toBeGreaterThan(0);
    expect(json.data.coverage).toMatchObject({ city: 'Bengaluru', state: 'Karnataka' });
    expect(json.data.coverage.localities).toEqual(['Indiranagar', 'Yelahanka']);
    expect(json.data.servedLocalities).toBe(2);
    // A count of zero here would be a lie the page repeats to a visitor.
    expect(json.data.verifiedProfessionals).toBe(1);
    expect(json.data.serverNow).toBeTruthy();
  });
});

it('resolves an addressId for its owner, and says which address was used', async () => {
  fake = build({
    profiles: () => ({
      data: {
        id: USER_ID,
        role: 'customer',
        status: 'active',
        full_name: 'Asha Rao',
        phone: '+919876543210',
        email: null,
      },
      error: null,
    }),
    customers: () => ({ data: { id: 'cust-1' }, error: null }),
    addresses: () => ({
      data: [{ id: ADDRESS_ID, customer_id: 'cust-1', locality_id: LOCALITY_ID }],
      error: null,
    }),
  });
  const res = await services(get(`/api/services?addressId=${ADDRESS_ID}`, TOKEN));
  const json = await body(res);
  expect(res.status).toBe(200);
  expect(json.data.location).toMatchObject({
    localityName: 'Indiranagar',
    addressId: ADDRESS_ID,
  });
  // The address is read through the caller's own customer row, never by id alone.
  const read = fake.calls.find((c) => c.table === 'addresses' && c.op === 'select');
  expect(read?.filters).toContainEqual(['customer_id', 'cust-1']);
});
