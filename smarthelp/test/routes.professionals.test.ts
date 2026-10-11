import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';
import {
  GET as getWorkingHours,
  PUT as putWorkingHours,
} from '@/app/api/professionals/me/working-hours/route';
import {
  GET as getTimeOff,
  POST as createTimeOff,
  DELETE as deleteTimeOff,
} from '@/app/api/professionals/me/time-off/route';
import {
  GET as getAvailability,
  POST as setAvailability,
} from '@/app/api/professionals/me/availability/route';
import { POST as arriveJob } from '@/app/api/professionals/jobs/[id]/arrive/route';
import { POST as verifyJobOtp } from '@/app/api/professionals/jobs/[id]/otp/route';
import { POST as completeJobRoute } from '@/app/api/professionals/jobs/[id]/complete/route';
import { POST as noShowJobRoute } from '@/app/api/professionals/jobs/[id]/no-show/route';
import { POST as regenerateOtp } from '@/app/api/bookings/[id]/otp/regenerate/route';
import { POST as kycUploadUrl } from '@/app/api/kyc-documents/upload-url/route';
import { GET as getKyc, POST as submitKycDocument } from '@/app/api/professionals/me/kyc/route';

/**
 * The professional's availability surface (§19.1): working hours, time off and
 * the online toggle.
 *
 * This is the Wave-0 harness `04-VALIDATION.md` requires. The KYC and job-execution
 * tasks append their cases to this same file, so the four constants below —
 * the profile, the professional row, the request builder and the mock — are
 * shared from the first test onward.
 *
 * The tests are as much about ownership as about saving: every route reaches
 * Postgres with the service role, so a query that forgot its `professional_id`
 * filter would pass a test that only checked the happy path. Each fixture
 * therefore contains a second professional's row that must not come back.
 */

const USER_ID = '00000000-0000-4000-8000-000000000011';
const TOKEN = 'pro-token';
const PROF_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_PROF_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const HOUR_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ENTRY_ID = 'cccccccc-1111-4111-8111-cccccccccccc';

let fake: FakeSupabase;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

const PROFILE = {
  id: USER_ID,
  role: 'professional',
  status: 'active',
  full_name: 'Ravi Kumar',
  phone: '+919876543210',
  email: null,
};

function professional(overrides: Record<string, unknown> = {}) {
  return {
    id: PROF_ID,
    profile_id: USER_ID,
    verification_status: 'verified',
    availability_status: 'offline',
    is_available_today: false,
    ...overrides,
  };
}

function workingHour(overrides: Record<string, unknown> = {}) {
  return {
    id: HOUR_ID,
    professional_id: PROF_ID,
    weekday: 1,
    start_time: '09:00:00',
    end_time: '17:00:00',
    is_active: true,
    ...overrides,
  };
}

function timeOff(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    professional_id: PROF_ID,
    starts_at: '2026-11-01T00:00:00.000Z',
    ends_at: '2026-11-02T00:00:00.000Z',
    reason: 'Family wedding',
    ...overrides,
  };
}

const DOC_ID = 'dddddddd-1111-4111-8111-dddddddddddd';

function professionalDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    professional_id: PROF_ID,
    doc_type: 'selfie',
    file_path: `${PROF_ID}/selfie/selfie.jpg`,
    status: 'submitted',
    rejection_reason: null,
    reviewed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function build(overrides: Record<string, any> = {}) {
  return new FakeSupabase({
    profiles: () => ({ data: PROFILE, error: null }),
    professionals: () => ({ data: [professional()], error: null }),
    professional_working_hours: () => ({
      data: [workingHour(), workingHour({ id: 'other-hour', professional_id: OTHER_PROF_ID })],
      error: null,
    }),
    professional_time_off: () => ({
      data: [timeOff(), timeOff({ id: 'other-entry', professional_id: OTHER_PROF_ID })],
      error: null,
    }),
    ...overrides,
  });
}

function request(url: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return new Request(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    headers,
  });
}

const body = async (res: Response) => (await res.json()) as any;

beforeEach(() => {
  fake = build();
});

// ── Working hours ───────────────────────────────────────────

describe('GET /api/professionals/me/working-hours', () => {
  it('needs a session', async () => {
    const res = await getWorkingHours(request('/api/professionals/me/working-hours'));
    expect(res.status).toBe(401);
  });

  it('returns only the caller\'s hours, in HH:MM', async () => {
    const res = await getWorkingHours(
      request('/api/professionals/me/working-hours', { token: TOKEN })
    );
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.hours).toHaveLength(1);
    expect(json.data.hours[0]).toMatchObject({
      id: HOUR_ID,
      weekday: 1,
      startTime: '09:00',
      endTime: '17:00',
    });
  });

  it('refuses an account with no professional row', async () => {
    fake = build({ professionals: () => ({ data: [], error: null }) });
    const res = await getWorkingHours(
      request('/api/professionals/me/working-hours', { token: TOKEN })
    );
    const json = await body(res);
    expect(res.status).toBe(403);
    expect(json.code).toBe('FORBIDDEN');
  });
});

describe('PUT /api/professionals/me/working-hours', () => {
  const week = {
    hours: [
      { weekday: 1, startTime: '09:00', endTime: '13:00' },
      { weekday: 2, startTime: '09:00', endTime: '17:00' },
    ],
  };

  it('replaces the week: delete then insert, both scoped to the caller', async () => {
    const res = await putWorkingHours(
      request('/api/professionals/me/working-hours', { method: 'PUT', body: week, token: TOKEN })
    );
    expect(res.status).toBe(200);

    const writes = fake.writesTo('professional_working_hours');
    const del = writes.find((w) => w.op === 'delete');
    const insert = writes.find((w) => w.op === 'insert');

    expect(del?.filters).toContainEqual(['professional_id', PROF_ID]);
    expect(insert?.payload).toEqual([
      { professional_id: PROF_ID, weekday: 1, start_time: '09:00', end_time: '13:00' },
      { professional_id: PROF_ID, weekday: 2, start_time: '09:00', end_time: '17:00' },
    ]);
  });

  it('an empty week clears the schedule', async () => {
    const res = await putWorkingHours(
      request('/api/professionals/me/working-hours', {
        method: 'PUT',
        body: { hours: [] },
        token: TOKEN,
      })
    );
    expect(res.status).toBe(200);
    const writes = fake.writesTo('professional_working_hours');
    expect(writes).toHaveLength(1);
    expect(writes[0].op).toBe('delete');
  });

  it('refuses two windows that overlap on the same weekday', async () => {
    const res = await putWorkingHours(
      request('/api/professionals/me/working-hours', {
        method: 'PUT',
        body: {
          hours: [
            { weekday: 1, startTime: '09:00', endTime: '13:00' },
            { weekday: 1, startTime: '12:00', endTime: '15:00' },
          ],
        },
        token: TOKEN,
      })
    );
    const json = await body(res);
    expect(res.status).toBe(400);
    expect(json.details.fields.hours).toMatch(/overlap/i);
    expect(fake.writesTo('professional_working_hours')).toHaveLength(0);
  });

  it('refuses a window outside 00:00–24:00', async () => {
    const res = await putWorkingHours(
      request('/api/professionals/me/working-hours', {
        method: 'PUT',
        body: { hours: [{ weekday: 1, startTime: '09:00', endTime: '25:00' }] },
        token: TOKEN,
      })
    );
    expect(res.status).toBe(400);
    expect(fake.writesTo('professional_working_hours')).toHaveLength(0);
  });

  it('refuses an end that is not after the start', async () => {
    const res = await putWorkingHours(
      request('/api/professionals/me/working-hours', {
        method: 'PUT',
        body: { hours: [{ weekday: 1, startTime: '17:00', endTime: '09:00' }] },
        token: TOKEN,
      })
    );
    expect(res.status).toBe(400);
  });

  it('never lets a body name another professional', async () => {
    await putWorkingHours(
      request('/api/professionals/me/working-hours', {
        method: 'PUT',
        body: { hours: [week.hours[0]], professional_id: OTHER_PROF_ID },
        token: TOKEN,
      })
    );
    const insert = fake
      .writesTo('professional_working_hours')
      .find((w) => w.op === 'insert');
    expect((insert?.payload as any[])[0].professional_id).toBe(PROF_ID);
  });
});

// ── Time off ────────────────────────────────────────────────

describe('GET /api/professionals/me/time-off', () => {
  it('needs a session', async () => {
    const res = await getTimeOff(request('/api/professionals/me/time-off'));
    expect(res.status).toBe(401);
  });

  it('returns only the caller\'s time off', async () => {
    const res = await getTimeOff(request('/api/professionals/me/time-off', { token: TOKEN }));
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.timeOff).toHaveLength(1);
    expect(json.data.timeOff[0]).toMatchObject({ id: ENTRY_ID, reason: 'Family wedding' });
  });

  it('filters the read by the caller\'s professional id', async () => {
    await getTimeOff(request('/api/professionals/me/time-off', { token: TOKEN }));
    const read = fake.calls.find((c) => c.table === 'professional_time_off');
    expect(read?.filters).toContainEqual(['professional_id', PROF_ID]);
  });
});

describe('POST /api/professionals/me/time-off', () => {
  it('books a block when the time is free', async () => {
    fake = build({ professional_time_off: () => ({ data: [], error: null }) });
    const res = await createTimeOff(
      request('/api/professionals/me/time-off', {
        method: 'POST',
        body: {
          startsAt: '2026-11-01T00:00:00.000Z',
          endsAt: '2026-11-02T00:00:00.000Z',
          reason: 'Family wedding',
        },
        token: TOKEN,
      })
    );
    const json = await body(res);
    expect(res.status).toBe(201);
    const insert = fake.writesTo('professional_time_off')[0];
    expect(insert?.payload).toMatchObject({
      professional_id: PROF_ID,
      reason: 'Family wedding',
    });
    expect(json.data.timeOff.startsAt).toBe('2026-11-01T00:00:00.000Z');
  });

  it('refuses a date already blocked, before writing', async () => {
    const res = await createTimeOff(
      request('/api/professionals/me/time-off', {
        method: 'POST',
        body: {
          startsAt: '2026-11-01T12:00:00.000Z',
          endsAt: '2026-11-01T18:00:00.000Z',
        },
        token: TOKEN,
      })
    );
    const json = await body(res);
    expect(res.status).toBe(409);
    expect(json.code).toBe('INVALID_STATE');
    expect(fake.writesTo('professional_time_off')).toHaveLength(0);
  });

  it('refuses an end before the start', async () => {
    fake = build({ professional_time_off: () => ({ data: [], error: null }) });
    const res = await createTimeOff(
      request('/api/professionals/me/time-off', {
        method: 'POST',
        body: { startsAt: '2026-11-02T00:00:00.000Z', endsAt: '2026-11-01T00:00:00.000Z' },
        token: TOKEN,
      })
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/professionals/me/time-off', () => {
  it('deletes the block, filtered by the owner', async () => {
    const res = await deleteTimeOff(
      request(`/api/professionals/me/time-off?entryId=${ENTRY_ID}`, {
        method: 'DELETE',
        token: TOKEN,
      })
    );
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.removed).toBe(true);
    const del = fake.writesTo('professional_time_off')[0];
    expect(del?.filters).toContainEqual(['id', ENTRY_ID]);
    expect(del?.filters).toContainEqual(['professional_id', PROF_ID]);
  });

  it('404s a block that is not the caller\'s', async () => {
    fake = build({ professional_time_off: () => ({ data: [], error: null }) });
    const res = await deleteTimeOff(
      request(`/api/professionals/me/time-off?entryId=${ENTRY_ID}`, {
        method: 'DELETE',
        token: TOKEN,
      })
    );
    expect(res.status).toBe(404);
  });

  it('needs an id to delete', async () => {
    const res = await deleteTimeOff(
      request('/api/professionals/me/time-off', { method: 'DELETE', token: TOKEN })
    );
    expect(res.status).toBe(400);
  });
});

// ── The online toggle ───────────────────────────────────────

describe('GET /api/professionals/me/availability', () => {
  it('returns the current state', async () => {
    const res = await getAvailability(
      request('/api/professionals/me/availability', { token: TOKEN })
    );
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data).toEqual({ availabilityStatus: 'offline', isAvailableToday: false });
  });
});

describe('POST /api/professionals/me/availability', () => {
  it('goes online through the server', async () => {
    const res = await setAvailability(
      request('/api/professionals/me/availability', {
        method: 'POST',
        body: { online: true },
        token: TOKEN,
      })
    );
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data).toEqual({ availabilityStatus: 'online', isAvailableToday: true });
    const update = fake.writesTo('professionals')[0];
    expect(update?.payload).toEqual({ availability_status: 'online', is_available_today: true });
    expect(update?.filters).toContainEqual(['id', PROF_ID]);
  });

  it('goes offline again', async () => {
    const res = await setAvailability(
      request('/api/professionals/me/availability', {
        method: 'POST',
        body: { online: false },
        token: TOKEN,
      })
    );
    const json = await body(res);
    expect(json.data).toEqual({ availabilityStatus: 'offline', isAvailableToday: false });
  });

  it('only accepts a boolean', async () => {
    const res = await setAvailability(
      request('/api/professionals/me/availability', {
        method: 'POST',
        body: { online: 'busy' },
        token: TOKEN,
      })
    );
    expect(res.status).toBe(400);
    expect(fake.writesTo('professionals')).toHaveLength(0);
  });

  it('refuses an account with no professional row', async () => {
    fake = build({ professionals: () => ({ data: [], error: null }) });
    const res = await setAvailability(
      request('/api/professionals/me/availability', {
        method: 'POST',
        body: { online: true },
        token: TOKEN,
      })
    );
    expect(res.status).toBe(403);
  });
});

// ── KYC upload URL (P4-01, Pitfall 10) ──────────────────────

describe('POST /api/kyc-documents/upload-url', () => {
  const valid = {
    docType: 'selfie',
    filename: 'selfie.jpg',
    contentType: 'image/jpeg',
    size: 1024,
  };

  it('needs a session', async () => {
    const res = await kycUploadUrl(request('/api/kyc-documents/upload-url', { method: 'POST', body: valid }));
    expect(res.status).toBe(401);
  });

  it('mints the path from the caller\'s own id, not the body', async () => {
    const res = await kycUploadUrl(
      request('/api/kyc-documents/upload-url', { method: 'POST', body: valid, token: TOKEN })
    );
    expect(res.status).toBe(200);
    expect(fake.storageCalls).toEqual([
      { bucket: 'kyc-documents', path: `${PROF_ID}/selfie/selfie.jpg` },
    ]);
  });

  it('never lets the filename climb out of the caller\'s folder', async () => {
    await kycUploadUrl(
      request('/api/kyc-documents/upload-url', {
        method: 'POST',
        body: { ...valid, filename: '../other/x.jpg' },
        token: TOKEN,
      })
    );
    const path = fake.storageCalls[0].path;
    expect(path.startsWith(`${PROF_ID}/selfie/`)).toBe(true);
    expect(path).not.toContain('..');
  });

  it('refuses a doc type off the three-value allow-list', async () => {
    const res = await kycUploadUrl(
      request('/api/kyc-documents/upload-url', {
        method: 'POST',
        body: { ...valid, docType: 'pan' },
        token: TOKEN,
      })
    );
    expect(res.status).toBe(400);
    expect(fake.storageCalls).toHaveLength(0);
  });

  it('refuses an oversized or wrong-typed file before minting', async () => {
    const tooBig = await kycUploadUrl(
      request('/api/kyc-documents/upload-url', {
        method: 'POST',
        body: { ...valid, size: 6 * 1024 * 1024 },
        token: TOKEN,
      })
    );
    expect(tooBig.status).toBe(400);

    const wrongType = await kycUploadUrl(
      request('/api/kyc-documents/upload-url', {
        method: 'POST',
        body: { ...valid, contentType: 'text/plain' },
        token: TOKEN,
      })
    );
    expect(wrongType.status).toBe(400);
    expect(fake.storageCalls).toHaveLength(0);
  });
});

// ── KYC read and submit (P4-01) ─────────────────────────────

describe('GET /api/professionals/me/kyc', () => {
  it('returns the roll-up status with the caller\'s documents', async () => {
    fake = build({ professional_documents: () => ({ data: [professionalDocument()], error: null }) });
    const res = await getKyc(request('/api/professionals/me/kyc', { token: TOKEN }));
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.verificationStatus).toBe('verified');
    expect(json.data.documents).toHaveLength(1);
    expect(json.data.documents[0]).toMatchObject({
      id: DOC_ID,
      docType: 'selfie',
      filePath: `${PROF_ID}/selfie/selfie.jpg`,
      status: 'submitted',
      rejectionReason: null,
    });
  });

  it('filters the read by the caller\'s professional id', async () => {
    fake = build({
      professional_documents: () => ({
        data: [professionalDocument(), professionalDocument({ id: 'other-doc', professional_id: OTHER_PROF_ID })],
        error: null,
      }),
    });
    const res = await getKyc(request('/api/professionals/me/kyc', { token: TOKEN }));
    const json = await body(res);
    expect(json.data.documents).toHaveLength(1);
  });

  it('never returns an internal reviewer note', async () => {
    fake = build({ professional_documents: () => ({ data: [professionalDocument()], error: null }) });
    const res = await getKyc(request('/api/professionals/me/kyc', { token: TOKEN }));
    const json = await body(res);
    expect(Object.keys(json.data.documents[0]).sort()).toEqual(
      ['createdAt', 'docType', 'filePath', 'id', 'rejectionReason', 'reviewedAt', 'status'].sort()
    );
    expect(JSON.stringify(json)).not.toContain('reviewer');
  });
});

describe('POST /api/professionals/me/kyc', () => {
  it('records a submitted row for the caller', async () => {
    fake = build({ professional_documents: () => ({ data: professionalDocument(), error: null }) });
    const res = await submitKycDocument(
      request('/api/professionals/me/kyc', {
        method: 'POST',
        body: { docType: 'selfie', filePath: `${PROF_ID}/selfie/selfie.jpg` },
        token: TOKEN,
      })
    );
    expect(res.status).toBe(201);
    const write = fake.writesTo('professional_documents')[0];
    expect(write?.op).toBe('upsert');
    expect(write?.payload).toMatchObject({
      professional_id: PROF_ID,
      doc_type: 'selfie',
      file_path: `${PROF_ID}/selfie/selfie.jpg`,
      status: 'submitted',
      rejection_reason: null,
    });
  });

  it('refuses a file path that belongs to another account', async () => {
    const res = await submitKycDocument(
      request('/api/professionals/me/kyc', {
        method: 'POST',
        body: { docType: 'selfie', filePath: `${OTHER_PROF_ID}/selfie/selfie.jpg` },
        token: TOKEN,
      })
    );
    expect(res.status).toBe(400);
    expect(fake.writesTo('professional_documents')).toHaveLength(0);
  });

  it('refuses a doc type off the allow-list', async () => {
    const res = await submitKycDocument(
      request('/api/professionals/me/kyc', {
        method: 'POST',
        body: { docType: 'pan', filePath: `${PROF_ID}/pan/pan.jpg` },
        token: TOKEN,
      })
    );
    expect(res.status).toBe(400);
    expect(fake.writesTo('professional_documents')).toHaveLength(0);
  });

  it('maps a locked document to a 409 rather than a 500', async () => {
    fake = build({
      professional_documents: () => ({
        data: null,
        error: { message: 'KYC_DOCUMENT_LOCKED' },
      }),
    });
    const res = await submitKycDocument(
      request('/api/professionals/me/kyc', {
        method: 'POST',
        body: { docType: 'selfie', filePath: `${PROF_ID}/selfie/selfie.jpg` },
        token: TOKEN,
      })
    );
    const json = await body(res);
    expect(res.status).toBe(409);
    expect(json.code).toBe('INVALID_STATE');
  });
});

// ── Arrival, the service OTP, and code regeneration (Task B3) ──

const BOOKING_ID = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
const CUSTOMER_ID = 'cccccccc-0000-4000-8000-0000000000c1';
const OTHER_CUSTOMER_ID = 'cccccccc-0000-4000-8000-0000000000c2';
const ADDRESS_LAT = 12.9784;
const ADDRESS_LNG = 77.6408;
const FAR_LAT = 19.076;
const FAR_LNG = 72.8777;

const CUSTOMER_PROFILE = {
  id: USER_ID,
  role: 'customer',
  status: 'active',
  full_name: 'Asha Rao',
  phone: '+919876500000',
  email: null,
};

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    booking_number: 'SH-20260201-00001',
    customer_id: CUSTOMER_ID,
    professional_id: PROF_ID,
    status: 'on_the_way',
    version: 4,
    duration_minutes: 60,
    scheduled_start_at: '2026-02-01T04:00:00.000Z',
    address_snapshot: {
      line1: '12 MG Road',
      area: 'Indiranagar',
      city: 'Bengaluru',
      pincode: '560038',
      lat: ADDRESS_LAT,
      lng: ADDRESS_LNG,
    },
    otp_hash: 'deadbeef',
    otp_expires_at: null,
    otp_locked_until: null,
    otp_generations: 0,
    started_at: null,
    ends_at: null,
    ...overrides,
  };
}

/**
 * A fake with RPC responses. `build()` only ever answers table reads, because
 * most routes write through tables; the job flow writes through `security
 * definer` functions, so these tests construct the fake directly and hand it a
 * responder per RPC name.
 */
function buildWithRpcs(
  rpcs: Record<string, (call: { args: Record<string, unknown> }) => { data: unknown; error: unknown }>,
  tables: Record<string, (call: unknown) => unknown> = {}
) {
  return new FakeSupabase(
    {
      profiles: () => ({ data: PROFILE, error: null }),
      professionals: () => ({ data: [professional()], error: null }),
      ...tables,
    } as any,
    rpcs as any
  );
}

describe('POST /api/professionals/jobs/[id]/arrive', () => {
  it('confirms arrival inside the radius and never returns otp_hash', async () => {
    let reads = 0;
    fake = buildWithRpcs(
      { arrive_job: () => ({ data: booking({ status: 'arrived' }), error: null }) },
      {
        bookings: () => ({
          data: [reads++ === 0 ? booking() : booking({ status: 'arrived', version: 5 })],
          error: null,
        }),
      }
    );

    const res = await arriveJob(
      request(`/api/professionals/jobs/${BOOKING_ID}/arrive`, {
        method: 'POST',
        body: { lat: ADDRESS_LAT, lng: ADDRESS_LNG },
        token: TOKEN,
      }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data.job.status).toBe('arrived');
    expect(json.data.job.address_snapshot).toBeTruthy();
    expect(JSON.stringify(json)).not.toContain('deadbeef');
    expect(fake.rpcCalls).toEqual([
      {
        fn: 'arrive_job',
        args: {
          p_booking_id: BOOKING_ID,
          p_professional_id: PROF_ID,
          p_expected_version: 4,
        },
      },
    ]);
  });

  it('refuses an arrival outside the radius and writes nothing', async () => {
    fake = buildWithRpcs(
      {},
      { bookings: () => ({ data: [booking()], error: null }) }
    );

    const res = await arriveJob(
      request(`/api/professionals/jobs/${BOOKING_ID}/arrive`, {
        method: 'POST',
        body: { lat: FAR_LAT, lng: FAR_LNG },
        token: TOKEN,
      }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(422);
    expect(json.code).toBe('VALIDATION_ERROR');
    expect(json.details.reason).toBe('outside_arrival_radius');
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('refuses when the address has no coordinates, even without a distance', async () => {
    fake = buildWithRpcs(
      {},
      { bookings: () => ({ data: [booking({ address_snapshot: {} })], error: null }) }
    );

    const res = await arriveJob(
      request(`/api/professionals/jobs/${BOOKING_ID}/arrive`, {
        method: 'POST',
        body: { lat: ADDRESS_LAT, lng: ADDRESS_LNG },
        token: TOKEN,
      }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(422);
    expect(json.details.reason).toBe('outside_arrival_radius');
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('records the override reason before it moves the booking', async () => {
    let reads = 0;
    fake = buildWithRpcs(
      { arrive_job: () => ({ data: booking({ status: 'arrived' }), error: null }) },
      {
        bookings: () => ({
          data: [reads++ === 0 ? booking() : booking({ status: 'arrived', version: 5 })],
          error: null,
        }),
      }
    );

    const res = await arriveJob(
      request(`/api/professionals/jobs/${BOOKING_ID}/arrive`, {
        method: 'POST',
        body: { lat: FAR_LAT, lng: FAR_LNG, overrideReason: 'Gate was locked' },
        token: TOKEN,
      }),
      { params: { id: BOOKING_ID } }
    );

    expect(res.status).toBe(200);
    expect(fake.rpcCalls.map((call) => call.fn)).toEqual(['write_audit', 'arrive_job']);
    expect(fake.rpcCalls[0].args.p_action).toBe('job.arrival_override');
    expect(fake.rpcCalls[0].args.p_metadata).toMatchObject({ reason: 'Gate was locked' });
  });

  it('maps a null return to a stale-version 409', async () => {
    fake = buildWithRpcs(
      { arrive_job: () => ({ data: null, error: null }) },
      { bookings: () => ({ data: [booking()], error: null }) }
    );

    const res = await arriveJob(
      request(`/api/professionals/jobs/${BOOKING_ID}/arrive`, {
        method: 'POST',
        body: { lat: ADDRESS_LAT, lng: ADDRESS_LNG },
        token: TOKEN,
      }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(409);
    expect(json.code).toBe('STALE_VERSION');
  });

  it('maps an illegal transition to a 409 rather than a 500', async () => {
    fake = buildWithRpcs(
      { arrive_job: () => ({ data: null, error: { message: 'ILLEGAL_TRANSITION' } }) },
      { bookings: () => ({ data: [booking({ status: 'accepted' })], error: null }) }
    );

    const res = await arriveJob(
      request(`/api/professionals/jobs/${BOOKING_ID}/arrive`, {
        method: 'POST',
        body: { lat: ADDRESS_LAT, lng: ADDRESS_LNG },
        token: TOKEN,
      }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(409);
    expect(json.code).toBe('ILLEGAL_TRANSITION');
  });

  it('refuses a job that belongs to another professional', async () => {
    fake = buildWithRpcs(
      {},
      { bookings: () => ({ data: [booking({ professional_id: OTHER_PROF_ID })], error: null }) }
    );

    const res = await arriveJob(
      request(`/api/professionals/jobs/${BOOKING_ID}/arrive`, {
        method: 'POST',
        body: { lat: ADDRESS_LAT, lng: ADDRESS_LNG },
        token: TOKEN,
      }),
      { params: { id: BOOKING_ID } }
    );

    expect(res.status).toBe(404);
    expect(fake.rpcCalls).toHaveLength(0);
  });
});

describe('POST /api/professionals/jobs/[id]/otp', () => {
  it('verifies the code and returns the running job', async () => {
    let reads = 0;
    fake = buildWithRpcs(
      {
        verify_service_otp: () => ({
          data: [{ started_at: '2026-02-01T04:05:00.000Z', ends_at: '2026-02-01T05:05:00.000Z' }],
          error: null,
        }),
      },
      {
        bookings: () => ({
          data: [
            reads++ === 0
              ? booking({ status: 'arrived' })
              : booking({
                  status: 'in_progress',
                  started_at: '2026-02-01T04:05:00.000Z',
                  ends_at: '2026-02-01T05:05:00.000Z',
                }),
          ],
          error: null,
        }),
      }
    );

    const res = await verifyJobOtp(
      request(`/api/professionals/jobs/${BOOKING_ID}/otp`, {
        method: 'POST',
        body: { code: '1234' },
        token: TOKEN,
      }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data.job.status).toBe('in_progress');
    expect(json.data.job.ends_at).toBe('2026-02-01T05:05:00.000Z');
    expect(JSON.stringify(json)).not.toContain('deadbeef');
    expect(fake.rpcCalls).toEqual([
      {
        fn: 'verify_service_otp',
        args: { p_booking_id: BOOKING_ID, p_code: '1234', p_max_attempts: 3 },
      },
    ]);
  });

  it('answers one generic 403 for a rejected code', async () => {
    fake = buildWithRpcs(
      { verify_service_otp: () => ({ data: [], error: null }) },
      { bookings: () => ({ data: [booking({ status: 'arrived' })], error: null }) }
    );

    const res = await verifyJobOtp(
      request(`/api/professionals/jobs/${BOOKING_ID}/otp`, {
        method: 'POST',
        body: { code: '9999' },
        token: TOKEN,
      }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(403);
    expect(json.code).toBe('OTP_INVALID');
    expect(json.error).toBe(
      'Invalid or expired code. Ask the customer for the current code, or request a new one if it has expired.'
    );
  });

  it('answers the same 403 for a locked code as for a wrong one', async () => {
    fake = buildWithRpcs(
      { verify_service_otp: () => ({ data: [], error: null }) },
      {
        bookings: () => ({
          data: [
            booking({
              status: 'arrived',
              otp_locked_until: '2099-01-01T00:00:00.000Z',
            }),
          ],
          error: null,
        }),
      }
    );

    const res = await verifyJobOtp(
      request(`/api/professionals/jobs/${BOOKING_ID}/otp`, {
        method: 'POST',
        body: { code: '1234' },
        token: TOKEN,
      }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(403);
    expect(json.code).toBe('OTP_INVALID');
  });

  it('refuses a code that is not four digits before touching the database', async () => {
    fake = buildWithRpcs({}, { bookings: () => ({ data: [booking({ status: 'arrived' })], error: null }) });

    const res = await verifyJobOtp(
      request(`/api/professionals/jobs/${BOOKING_ID}/otp`, {
        method: 'POST',
        body: { code: '12' },
        token: TOKEN,
      }),
      { params: { id: BOOKING_ID } }
    );

    expect(res.status).toBe(400);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('refuses a job that is not the caller\'s', async () => {
    fake = buildWithRpcs(
      {},
      { bookings: () => ({ data: [booking({ professional_id: OTHER_PROF_ID })], error: null }) }
    );

    const res = await verifyJobOtp(
      request(`/api/professionals/jobs/${BOOKING_ID}/otp`, {
        method: 'POST',
        body: { code: '1234' },
        token: TOKEN,
      }),
      { params: { id: BOOKING_ID } }
    );

    expect(res.status).toBe(404);
    expect(fake.rpcCalls).toHaveLength(0);
  });
});

describe('POST /api/bookings/[id]/otp/regenerate', () => {
  function customerFake(
    bookingOverrides: Record<string, unknown> = {},
    rpc: (call: { args: Record<string, unknown> }) => { data: unknown; error: unknown } = () => ({
      data: { id: BOOKING_ID, otp_expires_at: '2026-02-01T04:15:00.000Z' },
      error: null,
    }),
    customerRow: unknown = { id: CUSTOMER_ID, profile_id: USER_ID }
  ) {
    return new FakeSupabase(
      {
        profiles: () => ({ data: CUSTOMER_PROFILE, error: null }),
        customers: () => ({ data: customerRow, error: null }),
        bookings: () => ({ data: [booking(bookingOverrides)], error: null }),
      } as any,
      { issue_service_otp: rpc } as any
    );
  }

  it('mints a fresh code for the booking\'s customer', async () => {
    fake = customerFake({ status: 'arrived' });

    const res = await regenerateOtp(
      request(`/api/bookings/${BOOKING_ID}/otp/regenerate`, { method: 'POST', token: TOKEN }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data.code).toMatch(/^[0-9]{4}$/);
    expect(json.data.expiresAt).toBe('2026-02-01T04:15:00.000Z');
    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcCalls[0].args.p_booking_id).toBe(BOOKING_ID);
    expect(fake.rpcCalls[0].args.p_ttl_minutes).toBe(10);
    expect(String(fake.rpcCalls[0].args.p_code_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.rpcCalls[0].args.p_code_hash).not.toBe(json.data.code);
    expect(fake.rpcCalls[0].args.p_code_hash).not.toBe(undefined);
  });

  it('still mints below the generation cap', async () => {
    fake = customerFake({ status: 'arrived', otp_generations: 2 });

    const res = await regenerateOtp(
      request(`/api/bookings/${BOOKING_ID}/otp/regenerate`, { method: 'POST', token: TOKEN }),
      { params: { id: BOOKING_ID } }
    );

    expect(res.status).toBe(200);
    expect(fake.rpcCalls).toHaveLength(1);
  });

  it('stops at the generation cap', async () => {
    fake = customerFake({ status: 'arrived', otp_generations: 3 });

    const res = await regenerateOtp(
      request(`/api/bookings/${BOOKING_ID}/otp/regenerate`, { method: 'POST', token: TOKEN }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(409);
    expect(json.code).toBe('INVALID_STATE');
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('refuses a booking that has not arrived', async () => {
    fake = customerFake({ status: 'on_the_way' });

    const res = await regenerateOtp(
      request(`/api/bookings/${BOOKING_ID}/otp/regenerate`, { method: 'POST', token: TOKEN }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(409);
    expect(json.code).toBe('INVALID_STATE');
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('maps a null mint to a 409', async () => {
    fake = customerFake({ status: 'arrived' }, () => ({ data: null, error: null }));

    const res = await regenerateOtp(
      request(`/api/bookings/${BOOKING_ID}/otp/regenerate`, { method: 'POST', token: TOKEN }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(409);
    expect(json.code).toBe('INVALID_STATE');
  });

  it('refuses a caller who does not own the booking', async () => {
    fake = customerFake({ status: 'arrived', customer_id: OTHER_CUSTOMER_ID });

    const res = await regenerateOtp(
      request(`/api/bookings/${BOOKING_ID}/otp/regenerate`, { method: 'POST', token: TOKEN }),
      { params: { id: BOOKING_ID } }
    );

    expect(res.status).toBe(403);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('refuses a caller with no customer account', async () => {
    fake = customerFake({ status: 'arrived' }, undefined, null);

    const res = await regenerateOtp(
      request(`/api/bookings/${BOOKING_ID}/otp/regenerate`, { method: 'POST', token: TOKEN }),
      { params: { id: BOOKING_ID } }
    );

    expect(res.status).toBe(403);
    expect(fake.rpcCalls).toHaveLength(0);
  });
});

// ── Completion and no-show (Task C1) ──

describe('POST /api/professionals/jobs/[id]/complete', () => {
  it('completes a running job through one RPC and strips the OTP hash', async () => {
    let reads = 0;
    fake = buildWithRpcs(
      { complete_job: () => ({ data: booking({ status: 'completed' }), error: null }) },
      {
        bookings: () => ({
          data: [
            reads++ === 0
              ? booking({ status: 'in_progress' })
              : booking({
                  status: 'completed',
                  ended_at: '2026-02-01T05:05:00.000Z',
                  actual_duration_minutes: 60,
                }),
          ],
          error: null,
        }),
      }
    );

    const res = await completeJobRoute(
      request(`/api/professionals/jobs/${BOOKING_ID}/complete`, { method: 'POST', token: TOKEN }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data.job.status).toBe('completed');
    expect(json.data.job.actual_duration_minutes).toBe(60);
    expect(JSON.stringify(json)).not.toContain('deadbeef');
    expect(fake.rpcCalls).toEqual([
      {
        fn: 'complete_job',
        args: {
          p_booking_id: BOOKING_ID,
          p_professional_id: PROF_ID,
          p_expected_version: 4,
        },
      },
    ]);
  });

  it('maps an illegal transition to a 409 rather than a 500', async () => {
    fake = buildWithRpcs(
      { complete_job: () => ({ data: null, error: { message: 'ILLEGAL_TRANSITION' } }) },
      { bookings: () => ({ data: [booking({ status: 'completed' })], error: null }) }
    );

    const res = await completeJobRoute(
      request(`/api/professionals/jobs/${BOOKING_ID}/complete`, { method: 'POST', token: TOKEN }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(409);
    expect(json.code).toBe('ILLEGAL_TRANSITION');
  });

  it('maps a null return to a stale-version 409', async () => {
    fake = buildWithRpcs(
      { complete_job: () => ({ data: null, error: null }) },
      { bookings: () => ({ data: [booking({ status: 'in_progress' })], error: null }) }
    );

    const res = await completeJobRoute(
      request(`/api/professionals/jobs/${BOOKING_ID}/complete`, { method: 'POST', token: TOKEN }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(409);
    expect(json.code).toBe('STALE_VERSION');
  });

  it('refuses a job that belongs to another professional, with no write', async () => {
    fake = buildWithRpcs(
      {},
      { bookings: () => ({ data: [booking({ status: 'in_progress', professional_id: OTHER_PROF_ID })], error: null }) }
    );

    const res = await completeJobRoute(
      request(`/api/professionals/jobs/${BOOKING_ID}/complete`, { method: 'POST', token: TOKEN }),
      { params: { id: BOOKING_ID } }
    );

    expect(res.status).toBe(404);
    expect(fake.rpcCalls).toHaveLength(0);
  });
});

describe('POST /api/professionals/jobs/[id]/no-show', () => {
  it('records the reason, audits it, and touches no money path', async () => {
    let reads = 0;
    fake = buildWithRpcs(
      { no_show_job: () => ({ data: booking({ status: 'no_show' }), error: null }) },
      {
        bookings: () => ({
          data: [
            reads++ === 0
              ? booking({ status: 'in_progress' })
              : booking({ status: 'no_show' }),
          ],
          error: null,
        }),
      }
    );

    const res = await noShowJobRoute(
      request(`/api/professionals/jobs/${BOOKING_ID}/no-show`, {
        method: 'POST',
        body: { reason: 'Address not found' },
        token: TOKEN,
      }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data.job.status).toBe('no_show');
    expect(fake.rpcCalls.map((call) => call.fn)).toEqual(['no_show_job', 'write_audit']);
    expect(fake.rpcCalls[0].args).toEqual({
      p_booking_id: BOOKING_ID,
      p_professional_id: PROF_ID,
      p_reason: 'Address not found',
    });
    expect(fake.rpcCalls[1].args.p_action).toBe('job.no_show');
    expect(fake.rpcCalls[1].args.p_metadata).toMatchObject({ reason: 'Address not found' });
  });

  it('refuses a no-show without a reason before touching the database', async () => {
    fake = buildWithRpcs(
      {},
      { bookings: () => ({ data: [booking({ status: 'in_progress' })], error: null }) }
    );

    const res = await noShowJobRoute(
      request(`/api/professionals/jobs/${BOOKING_ID}/no-show`, {
        method: 'POST',
        body: {},
        token: TOKEN,
      }),
      { params: { id: BOOKING_ID } }
    );

    expect(res.status).toBe(400);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('maps an illegal transition to a 409 rather than a 500', async () => {
    fake = buildWithRpcs(
      { no_show_job: () => ({ data: null, error: { message: 'ILLEGAL_TRANSITION' } }) },
      { bookings: () => ({ data: [booking({ status: 'completed' })], error: null }) }
    );

    const res = await noShowJobRoute(
      request(`/api/professionals/jobs/${BOOKING_ID}/no-show`, {
        method: 'POST',
        body: { reason: 'Customer not available' },
        token: TOKEN,
      }),
      { params: { id: BOOKING_ID } }
    );
    const json = await body(res);

    expect(res.status).toBe(409);
    expect(json.code).toBe('ILLEGAL_TRANSITION');
  });

  it('refuses a job that is not the caller\'s, with no write', async () => {
    fake = buildWithRpcs(
      {},
      { bookings: () => ({ data: [booking({ status: 'in_progress', professional_id: OTHER_PROF_ID })], error: null }) }
    );

    const res = await noShowJobRoute(
      request(`/api/professionals/jobs/${BOOKING_ID}/no-show`, {
        method: 'POST',
        body: { reason: 'Customer not available' },
        token: TOKEN,
      }),
      { params: { id: BOOKING_ID } }
    );

    expect(res.status).toBe(404);
    expect(fake.rpcCalls).toHaveLength(0);
  });
});

