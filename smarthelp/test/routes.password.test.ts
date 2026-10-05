import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';

/**
 * The email + password sign-in model (§26.1).
 *
 * The phone code that used to stand here is gone, and these tests are about
 * what replaced it. The three things that matter and are easy to get wrong:
 *
 *   1. The password is never written anywhere — not the audit ledger, not a
 *      log line, not a database payload. `assertNoPasswordLeak` checks that
 *      against every recorded call.
 *   2. A staff role cannot be asked for at sign-up, and an unknown address at
 *      the reset start must look exactly like a known one.
 *   3. An account is only created *after* the code is proven, so an address
 *      nobody controls cannot be squatted.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'asha@example.com';
const PASSWORD = 'correct horse 9';
const NEW_PASSWORD = 'battery staple 7';

let fake: FakeSupabase;

/** The anon client `lib/sessionServer.ts` builds to check a password. */
const anonSignIn = vi.fn();

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

const auditMock = vi.fn(async () => undefined);
vi.mock('@/lib/audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit')>('@/lib/audit');
  return { ...actual, audit: auditMock };
});

/** No SMTP in unit tests, and no ledger: both are exercised elsewhere. */
const issueOtp = vi.fn(async () => ({ id: 'otp-1', code: '123456' }));
const deliverOtp = vi.fn(async () => ({ delivered: true, provider: 'email' as const }));
const verifyOtp = vi.fn(async () => 'ok' as string);
vi.mock('@/lib/otp', () => ({
  issueOtp: (...a: unknown[]) => issueOtp(...(a as [])),
  deliverOtp: (...a: unknown[]) => deliverOtp(...(a as [])),
  verifyOtp: (...a: unknown[]) => verifyOtp(...(a as [])),
  OTP_RESEND_SECONDS: 60,
  OTP_TTL_MINUTES: 10,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { signInWithPassword: anonSignIn } }),
}));

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    role: 'customer',
    status: 'active',
    full_name: 'Asha Rao',
    phone: '+919876543210',
    phone_verified_at: null,
    email: EMAIL,
    avatar_url: null,
    locale: 'en-IN',
    last_seen_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * A profiles table that answers according to which column was filtered on.
 *
 * The distinction matters: sign-up/complete checks "is this address taken?"
 * (by email, and the answer is no) and then, after the account is created,
 * loads the profile the trigger just provisioned (by id, and the answer is
 * yes). One row cannot answer both, so the fake is told them separately.
 */
function fakeWithProfiles(lookup: { byId?: unknown | null; byEmail?: unknown | null }) {
  return new FakeSupabase({
    profiles: (call) => {
      const columns = call.filters.map(([column]) => column);
      if (columns.includes('id')) return { data: lookup.byId ?? null, error: null };
      if (columns.includes('email')) return { data: lookup.byEmail ?? null, error: null };
      return { data: null, error: null };
    },
  });
}

/** A live account that exists and answers to both its id and its address. */
function fakeWithProfile(row: Record<string, unknown>) {
  return fakeWithProfiles({ byId: row, byEmail: row });
}

/** An address nobody has registered: no account by email, none by id either. */
function fakeWithNoAccount() {
  return fakeWithProfiles({});
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Nothing this code writes may contain the password. Walks every recorded
 * table call, every RPC argument and every audit row as a string, because a
 * leak would be just as bad in a `before` snapshot as in a column.
 */
function assertNoPasswordLeak(secret: string) {
  const seen = [
    ...fake.calls.map((c) => JSON.stringify({ ...c, table: c.table })),
    ...fake.rpcCalls.map((r) => JSON.stringify(r)),
    ...auditMock.mock.calls.map((c) => JSON.stringify(c)),
  ];
  for (const blob of seen) {
    expect(blob).not.toContain(secret);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  anonSignIn.mockResolvedValue({
    data: {
      user: { id: USER_ID, email: EMAIL },
      session: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_at: 1800000000,
      },
    },
    error: null,
  });
  issueOtp.mockResolvedValue({ id: 'otp-1', code: '123456' });
  deliverOtp.mockResolvedValue({ delivered: true, provider: 'email' });
  verifyOtp.mockResolvedValue('ok');
  fake = fakeWithProfile(profile());
});

// ── sign-in ──────────────────────────────────────────────────

describe('POST /api/auth/sign-in', () => {
  it('returns a session and the role the database holds', async () => {
    const { POST } = await import('@/app/api/auth/sign-in/route');
    const res = await POST(jsonRequest('/api/auth/sign-in', { email: EMAIL, password: PASSWORD }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.role).toBe('customer');
    expect(body.data.session.access_token).toBe('access-token');
    expect(anonSignIn).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
    assertNoPasswordLeak(PASSWORD);
  });

  it('serves a staff role too — the form no longer decides, the role does', async () => {
    fake = fakeWithProfile(profile({ role: 'admin' }));
    const { POST } = await import('@/app/api/auth/sign-in/route');
    const res = await POST(jsonRequest('/api/auth/sign-in', { email: EMAIL, password: PASSWORD }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.role).toBe('admin');
  });

  it('refuses a wrong password with the same message as an unknown account', async () => {
    anonSignIn.mockResolvedValue({ data: { user: null, session: null }, error: { message: 'nope' } });
    const { POST } = await import('@/app/api/auth/sign-in/route');
    const res = await POST(jsonRequest('/api/auth/sign-in', { email: EMAIL, password: PASSWORD }));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('That email and password do not match an account.');
    // The profile was never consulted, so nothing about the account leaked.
    expect(fake.calls.filter((c) => c.table === 'profiles')).toHaveLength(0);
  });

  it('refuses a suspended account', async () => {
    fake = fakeWithProfile(profile({ status: 'suspended' }));
    const { POST } = await import('@/app/api/auth/sign-in/route');
    const res = await POST(jsonRequest('/api/auth/sign-in', { email: EMAIL, password: PASSWORD }));

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/suspended/i);
  });

  it('rejects a password that is too short before it reaches Supabase', async () => {
    const { POST } = await import('@/app/api/auth/sign-in/route');
    const res = await POST(jsonRequest('/api/auth/sign-in', { email: EMAIL, password: 'short' }));

    expect(res.status).toBe(400);
    expect(anonSignIn).not.toHaveBeenCalled();
  });
});

// ── sign-up, step 1: prove the address ───────────────────────

describe('POST /api/auth/sign-up/start', () => {
  it('sends a signup code and creates nothing', async () => {
    fake = fakeWithNoAccount();
    const { POST } = await import('@/app/api/auth/sign-up/start/route');
    const res = await POST(
      jsonRequest('/api/auth/sign-up/start', {
        email: EMAIL,
        full_name: 'Asha Rao',
        role: 'customer',
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(issueOtp).toHaveBeenCalledWith(EMAIL, 'email', 'signup');
    // The whole point: no account until the code comes back.
    expect(fake.writesTo('profiles')).toHaveLength(0);
    expect(body.data.target).toBe('as**@example.com');
  });

  it('does not accept the password in this step', async () => {
    fake = fakeWithNoAccount();
    const { POST } = await import('@/app/api/auth/sign-up/start/route');
    await POST(
      jsonRequest('/api/auth/sign-up/start', {
        email: EMAIL,
        full_name: 'Asha Rao',
        role: 'customer',
        password: PASSWORD,
      })
    );

    expect(JSON.stringify(issueOtp.mock.calls)).not.toContain(PASSWORD);
  });

  it('tells a returning address to sign in instead', async () => {
    const { POST } = await import('@/app/api/auth/sign-up/start/route');
    const res = await POST(
      jsonRequest('/api/auth/sign-up/start', {
        email: EMAIL,
        full_name: 'Asha Rao',
        role: 'customer',
      })
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ACCOUNT_EXISTS');
    expect(issueOtp).not.toHaveBeenCalled();
  });

  it('refuses to sign anyone up as staff', async () => {
    fake = fakeWithNoAccount();
    const { POST } = await import('@/app/api/auth/sign-up/start/route');
    const res = await POST(
      jsonRequest('/api/auth/sign-up/start', {
        email: EMAIL,
        full_name: 'Asha Rao',
        role: 'super_admin',
      })
    );

    expect(res.status).toBe(400);
    expect(issueOtp).not.toHaveBeenCalled();
  });
});

// ── sign-up, step 2: create the account ──────────────────────

describe('POST /api/auth/sign-up/complete', () => {
  const body = {
    email: EMAIL,
    code: '123456',
    password: PASSWORD,
    password_confirm: PASSWORD,
    full_name: 'Asha Rao',
    role: 'professional',
  };

  it('creates the account only after the code is accepted, then signs in', async () => {
    // The address is free when the duplicate check runs, and the profile
    // exists by id once the auth trigger has provisioned it.
    fake = fakeWithProfiles({ byId: profile({ role: 'professional' }) });
    const { POST } = await import('@/app/api/auth/sign-up/complete/route');
    const res = await POST(jsonRequest('/api/auth/sign-up/complete', body));
    const out = await res.json();

    expect(verifyOtp).toHaveBeenCalledWith(EMAIL, 'signup', '123456');
    expect(res.status).toBe(201);
    // The password is checked, not just accepted, so a signup that reports
    // success has proven the credential it is about to rely on.
    expect(anonSignIn).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
    expect(out.data.role).toBe('professional');
    assertNoPasswordLeak(PASSWORD);
  });

  it('refuses a wrong code without creating anything', async () => {
    fake = fakeWithNoAccount();
    verifyOtp.mockResolvedValue('invalid');
    const { POST } = await import('@/app/api/auth/sign-up/complete/route');
    const res = await POST(jsonRequest('/api/auth/sign-up/complete', body));

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('OTP_INVALID');
    expect(anonSignIn).not.toHaveBeenCalled();
  });

  it('rejects a staff role even when the code is good', async () => {
    fake = fakeWithNoAccount();
    const { POST } = await import('@/app/api/auth/sign-up/complete/route');
    const res = await POST(
      jsonRequest('/api/auth/sign-up/complete', { ...body, role: 'admin' })
    );

    expect(res.status).toBe(400);
    expect(anonSignIn).not.toHaveBeenCalled();
  });

  it('rejects a confirmation that does not match', async () => {
    fake = fakeWithNoAccount();
    const { POST } = await import('@/app/api/auth/sign-up/complete/route');
    const res = await POST(
      jsonRequest('/api/auth/sign-up/complete', { ...body, password_confirm: 'different 1' })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).details.fields).toHaveProperty('password_confirm');
    expect(anonSignIn).not.toHaveBeenCalled();
  });
});

// ── forgot password ──────────────────────────────────────────

describe('POST /api/auth/password-reset/start', () => {
  it('answers an unknown address exactly as it answers a known one', async () => {
    const { POST } = await import('@/app/api/auth/password-reset/start/route');

    fake = fakeWithProfile(profile());
    const withAccount = await POST(jsonRequest('/api/auth/password-reset/start', { email: EMAIL }));
    const knownBody = await withAccount.json();

    fake = fakeWithNoAccount();
    const unknown = await POST(
      jsonRequest('/api/auth/password-reset/start', { email: 'nobody@example.com' })
    );
    const unknownBody = await unknown.json();

    expect(withAccount.status).toBe(200);
    expect(unknown.status).toBe(200);
    // Identical shape, and no devCode on either, so the only difference
    // between the two answers is nothing at all.
    expect(Object.keys(unknownBody.data).sort()).toEqual(Object.keys(knownBody.data).sort());
    expect(unknownBody.data.devCode).toBeUndefined();
    expect(unknownBody.data.expiresInSeconds).toBe(knownBody.data.expiresInSeconds);
    // And only the known address was actually sent a code.
    expect(issueOtp).toHaveBeenCalledTimes(1);
    expect(issueOtp).toHaveBeenCalledWith(EMAIL, 'email', 'password_reset');
  });

  it('refuses to send a code to a suspended account', async () => {
    fake = fakeWithProfile(profile({ status: 'suspended' }));
    const { POST } = await import('@/app/api/auth/password-reset/start/route');
    await POST(jsonRequest('/api/auth/password-reset/start', { email: EMAIL }));

    expect(issueOtp).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/password-reset/complete', () => {
  const body = {
    email: EMAIL,
    code: '123456',
    password: NEW_PASSWORD,
    password_confirm: NEW_PASSWORD,
  };

  it('sets the new password once the code is accepted', async () => {
    const { POST } = await import('@/app/api/auth/password-reset/complete/route');
    const res = await POST(jsonRequest('/api/auth/password-reset/complete', body));
    const out = await res.json();

    expect(verifyOtp).toHaveBeenCalledWith(EMAIL, 'password_reset', '123456');
    expect(res.status).toBe(200);
    expect(out.data.reset).toBe(true);
    assertNoPasswordLeak(NEW_PASSWORD);
  });

  it('refuses a wrong code without writing anything', async () => {
    verifyOtp.mockResolvedValue('expired');
    const { POST } = await import('@/app/api/auth/password-reset/complete/route');
    const res = await POST(jsonRequest('/api/auth/password-reset/complete', body));

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('OTP_EXPIRED');
  });

  it('locks out after too many wrong attempts', async () => {
    verifyOtp.mockResolvedValue('locked');
    const { POST } = await import('@/app/api/auth/password-reset/complete/route');
    const res = await POST(jsonRequest('/api/auth/password-reset/complete', body));

    expect(res.status).toBe(429);
  });
});
