import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';
import { GET as serviceReminders } from '@/app/api/cron/service-reminders/route';
import { GET as ratingReminders } from '@/app/api/cron/rating-reminders/route';

/**
 * The reminder crons (§25.11, D5).
 *
 * The pass itself — who is due, the advisory lock, the idempotency guard — is
 * SQL in `0041` and is exercised by the database suite. What lives here is the
 * shell: the guard fails closed, and the route calls the one RPC the schedule
 * names and reports its count. The strongest thing a route test can say about a
 * thin shell is that it is thin, so the assertions are about the call, not the
 * SQL.
 */

const CRON_SECRET = 'test-cron-secret-0123456789';

let fake: FakeSupabase;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

function build(sent: number) {
  return new FakeSupabase({}, {
    run_service_reminders: () => ({ data: { sent }, error: null }),
    run_rating_reminders: () => ({ data: { sent }, error: null }),
  });
}

function req(path: string, query = '', headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}${query}`, { headers });
}

const data = async (res: Response) => (await res.json()) as any;

beforeEach(() => {
  fake = build(0);
  vi.stubEnv('CRON_SECRET', CRON_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each([
  ['service-reminders', serviceReminders, 'run_service_reminders'],
  ['rating-reminders', ratingReminders, 'run_rating_reminders'],
] as const)('GET /api/cron/%s', (name, handler, rpc) => {
  const path = `/api/cron/${name}`;

  it('fails closed when CRON_SECRET is unset, with zero database calls', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const res = await handler(req(path));
    expect(res.status).toBe(503);
    expect((await data(res)).code).toBe('SERVICE_UNAVAILABLE');
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('is a 401 on a wrong secret and never reaches the RPC', async () => {
    const res = await handler(req(path, '', { authorization: 'Bearer nope' }));
    expect(res.status).toBe(401);
    expect((await data(res)).code).toBe('UNAUTHENTICATED');
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('accepts the scheduler and reports the count the function returned', async () => {
    fake = build(3);
    const res = await handler(req(path, '', { authorization: `Bearer ${CRON_SECRET}` }));
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ success: true, data: { sent: 3 } });

    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcCalls[0]!.fn).toBe(rpc);
  });

  it('accepts the x-cron-secret header and the ?secret= query', async () => {
    const viaHeader = await handler(req(path, '', { 'x-cron-secret': CRON_SECRET }));
    expect(viaHeader.status).toBe(200);
    const viaQuery = await handler(req(path, `?secret=${CRON_SECRET}`));
    expect(viaQuery.status).toBe(200);
  });

  it('answers a zero pass when the function reports nothing due', async () => {
    fake = build(0);
    const res = await handler(req(path, '', { authorization: `Bearer ${CRON_SECRET}` }));
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ data: { sent: 0 } });
  });
});
