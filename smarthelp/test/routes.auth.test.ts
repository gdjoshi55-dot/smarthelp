import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';

/**
 * Route Handler tests (§29.1 asks for one happy path and one failure path per
 * endpoint). The service-role client is replaced with a fake, so these are
 * branch tests: they assert what the route decides, and which row it writes,
 * without needing a live Supabase project.
 */

const PHONE = '+919876543210';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const PROFESSIONAL_ID = '44444444-4444-4444-8444-444444444444';
const SYNTHETIC_EMAIL = '919876543210@auth.smarthelp.invalid';

let fake: FakeSupabase;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

// `write_audit` is a real RPC in production; here it just records.
vi.mock('@/lib/audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit')>('@/lib/audit');
  return { ...actual, audit: vi.fn(async () => undefined) };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}));

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    role: 'customer',
    status: 'active',
    full_name: 'Asha Rao',
    phone: PHONE,
    phone_verified_at: null,
    email: null,
    avatar_url: null,
    locale: 'en-IN',
    last_seen_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function jsonRequest(url: string, body: unknown, token?: string): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  fake = new FakeSupabase();
});

// ── send-otp ────────────────────────────────────────────────

describe('POST /api/auth/send-otp', () => {
  it('provisions the account, records the audit row and issues a code', async () => {
    // No profile yet: this is a first-time sign-in, so the auth user and the
    // profile are created here.
    fake = new FakeSupabase(
      {
        profiles: () => ({ data: null, error: null }),
      },
      { issue_otp: () => ({ data: 'otp-id', error: null }) }
    );

    const { POST } = await import('@/app/api/auth/send-otp/route');
    const res = await POST(
      jsonRequest('/api/auth/send-otp', { channel: 'phone', phone: '9876543210' })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.target).toBe(PHONE);
    // No SMS provider is configured in the test env, so the dev code is echoed.
    expect(body.data.devCode).toMatch(/^\d{6}$/);
    expect(body.data.resendInSeconds).toBe(60);

    expect(fake.rpcCalls.some((c) => c.fn === 'issue_otp')).toBe(true);
    const { audit } = await import('@/lib/audit');
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.otp_requested' })
    );
  });

  it('refuses a staff code sent to a phone number', async () => {
    const { POST } = await import('@/app/api/auth/send-otp/route');
    const res = await POST(
      jsonRequest('/api/auth/send-otp', {
        channel: 'phone',
        purpose: 'staff_login',
        phone: '9876543210',
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('email address');
  });

  it('refuses a login code sent to an email address', async () => {
    const { POST } = await import('@/app/api/auth/send-otp/route');
    const res = await POST(
      jsonRequest('/api/auth/send-otp', {
        channel: 'email',
        purpose: 'login',
        email: 'a@b.com',
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).details.fields.phone).toBeTruthy();
  });

  it('rejects a malformed body with field-level detail', async () => {
    const { POST } = await import('@/app/api/auth/send-otp/route');
    const res = await POST(jsonRequest('/api/auth/send-otp', { channel: 'phone', phone: '123' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details.fields).toHaveProperty('phone');
  });

  it('surfaces the resend throttle as 429, with the wait, not as a generic failure', async () => {
    fake = new FakeSupabase(
      { profiles: () => ({ data: profile(), error: null }) },
      { issue_otp: () => ({ data: null, error: { message: 'OTP_THROTTLED' } }) }
    );

    const { POST } = await import('@/app/api/auth/send-otp/route');
    const res = await POST(
      jsonRequest('/api/auth/send-otp', { channel: 'phone', phone: '9876543210' })
    );

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.details.retryAfterSeconds).toBe(60);
    // A throttle must not be logged as a server fault.
    expect(body.error).not.toContain('INTERNAL');
  });
});

// ── verify-otp ──────────────────────────────────────────────

describe('POST /api/auth/verify-otp', () => {
  async function loadRoute() {
    return import('@/app/api/auth/verify-otp/route');
  }

  it('returns a token hash for a good code', async () => {
    fake = new FakeSupabase(
      { profiles: () => ({ data: null, error: null }) },
      { consume_otp: () => ({ data: 'ok', error: null }) }
    );

    const { POST } = await loadRoute();
    const res = await POST(
      jsonRequest('/api/auth/verify-otp', {
        channel: 'phone',
        phone: '9876543210',
        code: '123456',
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tokenHash).toBeTruthy();
    expect(body.data.email).toBe(SYNTHETIC_EMAIL);
  });

  it('does not hand out a session for a wrong code', async () => {
    fake = new FakeSupabase(
      { profiles: () => ({ data: null, error: null }) },
      { consume_otp: () => ({ data: 'invalid', error: null }) }
    );

    const { POST } = await loadRoute();
    const res = await POST(
      jsonRequest('/api/auth/verify-otp', {
        channel: 'phone',
        phone: '9876543210',
        code: '000000',
      })
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('OTP_INVALID');
    expect(body.data).toBeUndefined();
  });

  it('distinguishes an expired code from a wrong one, and a locked target from both', async () => {
    for (const [outcome, expectedCode, expectedStatus] of [
      ['expired', 'OTP_EXPIRED', 422],
      ['locked', 'OTP_LOCKED', 429],
    ] as const) {
      fake = new FakeSupabase(
        { profiles: () => ({ data: null, error: null }) },
        { consume_otp: () => ({ data: outcome, error: null }) }
      );
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest('/api/auth/verify-otp', {
          channel: 'phone',
          phone: '9876543210',
          code: '123456',
        })
      );
      expect(res.status).toBe(expectedStatus);
      expect((await res.json()).code).toBe(expectedCode);
    }
  });

  it('tells a locked target how long to wait', async () => {
    fake = new FakeSupabase(
      { profiles: () => ({ data: null, error: null }) },
      { consume_otp: () => ({ data: 'locked', error: null }) }
    );
    const { POST } = await loadRoute();
    const res = await POST(
      jsonRequest('/api/auth/verify-otp', { channel: 'phone', phone: '9876543210', code: '123456' })
    );
    expect((await res.json()).details.retryAfterSeconds).toBe(900);
  });

  it('refuses to open a staff session for a customer email', async () => {
    fake = new FakeSupabase(
      { profiles: () => ({ data: profile({ email: 'someone@smarthelp.in' }), error: null }) },
      { consume_otp: () => ({ data: 'ok', error: null }) }
    );

    const { POST } = await loadRoute();
    const res = await POST(
      jsonRequest('/api/auth/verify-otp', {
        channel: 'email',
        email: 'someone@smarthelp.in',
        code: '123456',
        purpose: 'staff_login',
      })
    );
    expect(res.status).toBe(403);
  });

  it('refuses a suspended staff account', async () => {
    fake = new FakeSupabase(
      {
        profiles: () => ({
          data: profile({ role: 'admin', email: 'a@b.com', status: 'suspended' }),
          error: null,
        }),
      },
      { consume_otp: () => ({ data: 'ok', error: null }) }
    );

    const { POST } = await loadRoute();
    const res = await POST(
      jsonRequest('/api/auth/verify-otp', {
        channel: 'email',
        email: 'a@b.com',
        code: '123456',
        purpose: 'staff_login',
      })
    );
    expect(res.status).toBe(403);
  });

  it('401s when the email has no account at all', async () => {
    fake = new FakeSupabase(
      { profiles: () => ({ data: null, error: null }) },
      { consume_otp: () => ({ data: 'ok', error: null }) }
    );

    const { POST } = await loadRoute();
    const res = await POST(
      jsonRequest('/api/auth/verify-otp', {
        channel: 'email',
        email: 'nobody@smarthelp.in',
        code: '123456',
        purpose: 'staff_login',
      })
    );
    expect(res.status).toBe(401);
  });
});

// ── GET /api/auth/me ────────────────────────────────────────

describe('GET /api/auth/me', () => {
  async function loadRoute() {
    return import('@/app/api/auth/me/route');
  }

  it('401s without a bearer token, before touching the database', async () => {
    const { GET } = await loadRoute();
    const res = await GET(new Request('http://localhost/api/auth/me'));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('UNAUTHENTICATED');
    expect(fake.calls).toHaveLength(0);
  });

  it('401s when the token does not resolve to a user', async () => {
    fake = new FakeSupabase();
    fake.auth.getUser = async () => ({ data: { user: null }, error: { message: 'bad token' } });

    const { GET } = await loadRoute();
    const res = await GET(
      new Request('http://localhost/api/auth/me', {
        headers: { authorization: 'Bearer nonsense' },
      })
    );
    expect(res.status).toBe(401);
  });

  it('403s a suspended account, with copy that says what to do', async () => {
    fake = new FakeSupabase();
    fake.auth.getUser = async () => ({ data: { user: { id: USER_ID } }, error: null });
    fake = new FakeSupabase({
      profiles: () => ({ data: profile({ status: 'suspended' }), error: null }),
    });
    fake.auth.getUser = async () => ({ data: { user: { id: USER_ID } }, error: null });

    const { GET } = await loadRoute();
    const res = await GET(
      new Request('http://localhost/api/auth/me', {
        headers: { authorization: 'Bearer token' },
      })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('suspended');
  });

  it('returns the role, its capabilities and the home to go to', async () => {
    fake = new FakeSupabase({
      profiles: () => ({ data: profile(), error: null }),
      customers: () => ({
        data: {
          id: 'c1',
          referral_code: 'ASHA100',
          total_bookings: 3,
          completed_bookings: 2,
          lifetime_value: 2400,
        },
        error: null,
      }),
      professionals: () => ({ data: null, error: null }),
    });
    fake.auth.getUser = async () => ({ data: { user: { id: USER_ID } }, error: null });

    const { GET } = await loadRoute();
    const res = await GET(
      new Request('http://localhost/api/auth/me', {
        headers: { authorization: 'Bearer token' },
      })
    );

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.role).toBe('customer');
    expect(data.home).toBe('/customer');
    // §3.2's row: a customer creates and cancels their own bookings. Phase 2 added
    // these grants, so the array is no longer empty — it is the set of own-account
    // booking capabilities and nothing wider.
    expect(data.capabilities).toEqual(['booking.create', 'booking.cancel.own']);
    expect(data.customer.referral_code).toBe('ASHA100');
    expect(data.professional).toBeNull();
    // The role in the response is the one in the row, not one the client sent.
    expect(data.profile.role).toBe('customer');
  });
});

// ── PUT /api/auth/me ────────────────────────────────────────

describe('PUT /api/auth/me', () => {
  async function loadRoute() {
    return import('@/app/api/auth/me/route');
  }

  beforeEach(() => {
    fake = new FakeSupabase({
      profiles: (call) =>
        call.op === 'update'
          ? { data: profile({ full_name: 'Asha R Rao' }), error: null }
          : { data: profile(), error: null },
    });
    fake.auth.getUser = async () => ({ data: { user: { id: USER_ID } }, error: null });
  });

  it('writes only the fields it is allowed to', async () => {
    const { PUT } = await loadRoute();
    const res = await PUT(
      jsonRequest('/api/auth/me', { full_name: 'Asha R Rao', role: 'super_admin' }, 'token')
    );

    expect(res.status).toBe(200);
    const update = fake.writesTo('profiles')[0];
    expect(update?.payload).toEqual({ full_name: 'Asha R Rao' });
    expect((update?.payload as Record<string, unknown>).role).toBeUndefined();
  });

  it('rejects an empty patch rather than writing nothing', async () => {
    const { PUT } = await loadRoute();
    const res = await PUT(jsonRequest('/api/auth/me', {}, 'token'));
    expect(res.status).toBe(400);
  });

  it('turns a unique-violation on email into a 409 with field detail', async () => {
    fake = new FakeSupabase({
      profiles: (call) =>
        call.op === 'update'
          ? { data: null, error: { message: 'duplicate key', code: '23505' } }
          : { data: profile(), error: null },
    });
    fake.auth.getUser = async () => ({ data: { user: { id: USER_ID } }, error: null });

    const { PUT } = await loadRoute();
    const res = await PUT(jsonRequest('/api/auth/me', { email: 'taken@x.com' }, 'token'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.details.fields.email).toBe('Already in use');
  });

  it('401s without a token', async () => {
    const { PUT } = await loadRoute();
    const res = await PUT(jsonRequest('/api/auth/me', { full_name: 'X Y' }));
    expect(res.status).toBe(401);
  });
});

// ── POST /api/auth/professional/apply ───────────────────────

describe('POST /api/auth/professional/apply', () => {
  async function loadRoute() {
    return import('@/app/api/auth/professional/apply/route');
  }

  const body = {
    service_ids: [SERVICE_ID],
    experience_months: 36,
    documents: [{ doc_type: 'aadhaar_front', file_path: `kyc/${USER_ID}/aadhaar.jpg` }],
  };

  function asCustomer() {
    fake.auth.getUser = async () => ({ data: { user: { id: USER_ID } }, error: null });
  }

  it('promotes a customer, creates the professional row and records the skills', async () => {
    fake = new FakeSupabase({
      profiles: (call) =>
        call.op === 'update'
          ? { data: profile({ role: 'professional' }), error: null }
          : { data: profile(), error: null },
      professionals: (call) => {
        if (call.op === 'insert') {
          return { data: { id: PROFESSIONAL_ID, verification_status: 'not_submitted' }, error: null };
        }
        if (call.op === 'update') {
          // The route moves the row out of `not_submitted` once documents land.
          return { data: { id: PROFESSIONAL_ID, verification_status: 'submitted' }, error: null };
        }
        return { data: null, error: null };
      },
      services: () => ({ data: [{ id: SERVICE_ID, is_active: true }], error: null }),
      professional_skills: () => ({ data: null, error: null }),
      professional_documents: () => ({ data: null, error: null }),
      customers: () => ({ data: null, error: null }),
    });
    asCustomer();

    const { POST } = await loadRoute();
    const res = await POST(jsonRequest('/api/auth/professional/apply', body, 'token'));

    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.professionalId).toBe(PROFESSIONAL_ID);
    expect(data.verificationStatus).toBe('submitted');
    expect(data.nextStep).toContain('review');

    // The role really was promoted, not just reported as promoted.
    const profileWrite = fake.writesTo('profiles')[0];
    expect(profileWrite?.payload).toEqual({ role: 'professional' });
    expect(fake.writesTo('customers').length).toBe(1);

    // ...and the status really was written, not only echoed back.
    const statusWrites = fake
      .writesTo('professionals')
      .filter((c) => (c.payload as { verification_status?: string })?.verification_status === 'submitted');
    expect(statusWrites.length).toBe(1);

    // Documents are stored as paths, always as `submitted`, never as a URL.
    const docWrite = fake.writesTo('professional_documents')[0];
    expect(docWrite?.payload).toMatchObject({
      professional_id: PROFESSIONAL_ID,
      status: 'submitted',
    });
    expect((docWrite?.payload as { file_path: string }).file_path).toMatch(/^kyc\//);

    // Skills are written for exactly the services that were validated.
    expect(fake.writesTo('professional_skills').find((c) => c.op === 'upsert')?.payload).toEqual([
      { professional_id: PROFESSIONAL_ID, service_id: SERVICE_ID, proficiency: 3 },
    ]);

    // The experience is stored, and the customer row is gone, not orphaned.
    expect(
      fake
        .writesTo('professionals')
        .some((c) => (c.payload as { experience_months?: number })?.experience_months === 36)
    ).toBe(true);
    expect(fake.writesTo('customers')[0]?.op).toBe('delete');
  });

  it('refuses a service that is not on the active catalogue', async () => {
    fake = new FakeSupabase({
      profiles: () => ({ data: profile(), error: null }),
      services: () => ({ data: [], error: null }),
    });
    asCustomer();

    const { POST } = await loadRoute();
    const res = await POST(jsonRequest('/api/auth/professional/apply', body, 'token'));
    expect(res.status).toBe(400);
    expect((await res.json()).details.fields.service_ids).toBe('Refresh and pick again');
  });

  it('is idempotent: applying twice returns 200 and does not duplicate the row', async () => {
    fake = new FakeSupabase({
      profiles: () => ({ data: profile({ role: 'professional' }), error: null }),
      professionals: (call) =>
        call.op === 'insert'
          ? { data: null, error: null }
          : {
              data: {
                id: PROFESSIONAL_ID,
                profile_id: USER_ID,
                verification_status: 'submitted',
                role: 'professional',
              },
              error: null,
            },
      services: () => ({ data: [{ id: SERVICE_ID, is_active: true }], error: null }),
      professional_skills: () => ({ data: null, error: null }),
      professional_documents: () => ({ data: null, error: null }),
    });
    asCustomer();

    const { POST } = await loadRoute();
    const res = await POST(jsonRequest('/api/auth/professional/apply', body, 'token'));

    expect(res.status).toBe(200);
    // No insert into professionals: the existing row is updated in place.
    expect(fake.writesTo('professionals').filter((c) => c.op === 'insert')).toHaveLength(0);
    // Skills are replaced wholesale, so a removal is an un-insert.
    expect(fake.writesTo('professional_skills').filter((c) => c.op === 'delete')).toHaveLength(1);
  });

  it('401s an anonymous caller', async () => {
    fake = new FakeSupabase();
    const { POST } = await loadRoute();
    const res = await POST(jsonRequest('/api/auth/professional/apply', body));
    expect(res.status).toBe(401);
  });

  it('rejects a malformed document type', async () => {
    fake = new FakeSupabase({
      profiles: () => ({ data: profile(), error: null }),
    });
    asCustomer();

    const { POST } = await loadRoute();
    const res = await POST(
      jsonRequest(
        '/api/auth/professional/apply',
        { ...body, documents: [{ doc_type: 'my_holiday_photo', file_path: 'kyc/x.jpg' }] },
        'token'
      )
    );
    expect(res.status).toBe(400);
  });
});

// ── sign-out ────────────────────────────────────────────────

describe('POST /api/auth/sign-out', () => {
  it('401s without a token', async () => {
    const { POST } = await import('@/app/api/auth/sign-out/route');
    const res = await POST(new Request('http://localhost/api/auth/sign-out', { method: 'POST' }));
    expect(res.status).toBe(401);
  });

  it('revokes server-side and records the audit row', async () => {
    fake = new FakeSupabase({ profiles: () => ({ data: profile(), error: null }) });
    fake.auth.getUser = async () => ({ data: { user: { id: USER_ID } }, error: null });

    const { POST } = await import('@/app/api/auth/sign-out/route');
    const res = await POST(
      new Request('http://localhost/api/auth/sign-out', {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
      })
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.revoked).toBe(true);

    const { audit } = await import('@/lib/audit');
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.sign_out' })
    );
  });
});

// A second user, to prove the ownership filters are not vacuous.
describe('cross-account isolation', () => {
  it('the me route scopes its read to the caller, not to a parameter', async () => {
    fake = new FakeSupabase({
      profiles: () => ({ data: profile({ id: OTHER_USER_ID }), error: null }),
      customers: () => ({ data: null, error: null }),
      professionals: () => ({ data: null, error: null }),
    });
    fake.auth.getUser = async () => ({ data: { user: { id: USER_ID } }, error: null });

    const { GET } = await import('@/app/api/auth/me/route');
    await GET(
      new Request('http://localhost/api/auth/me', {
        headers: { authorization: 'Bearer token' },
      })
    );

    // Every read is filtered by the authenticated id from the token.
    for (const call of fake.calls.filter((c) => c.table === 'profiles')) {
      if (call.op === 'select') {
        expect(call.filters).toContainEqual(['id', USER_ID]);
      }
    }
  });
});
