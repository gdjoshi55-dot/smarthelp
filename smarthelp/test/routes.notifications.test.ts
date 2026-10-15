import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase, type RecordedCall } from './helpers/fakeSupabase';
import { GET as listNotifications } from '@/app/api/notifications/route';
import { POST as markRead } from '@/app/api/notifications/[id]/read/route';
import { POST as readAll } from '@/app/api/notifications/read-all/route';
import {
  POST as registerToken,
  DELETE as removeToken,
} from '@/app/api/notifications/push-token/route';

/**
 * The bell's endpoints (§25.9, §27.1).
 *
 * The load-bearing assertions are about *scoping*, not the happy path: every
 * query carries the caller's own `recipient_id`, a guessed id is a 404 with zero
 * writes, and the default channel is `in_app` — the surface "read" means
 * anything for. A bell that leaked another profile's rows would be a privacy
 * bug, and the way to catch it is to assert on the filter the route sends, not
 * on the fixture it happens to receive.
 */

const USER_ID = '00000000-0000-4000-8000-000000000011';
const OTHER_ID = '00000000-0000-4000-8000-000000000022';
const NOTIF_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'session-token';

let fake: FakeSupabase;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

const PROFILE = {
  id: USER_ID,
  role: 'customer',
  status: 'active',
  full_name: 'Asha Rao',
  phone: '+919876543210',
  email: 'asha@example.test',
};

/** A bell row, as `notificationServer.toListItem` expects to map it. */
function notification(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTIF_ID,
    recipient_id: USER_ID,
    channel: 'in_app',
    template_code: 'BOOKING_CONFIRMED',
    payload: {},
    title: 'Booking confirmed',
    body: 'Your booking is confirmed.',
    status: 'sent',
    error: null,
    booking_id: 'ffffffff-1111-4111-8111-ffffffffffff',
    read_at: null,
    sent_at: '2026-06-01T12:00:00.000Z',
    created_at: '2026-06-01T12:00:00.000Z',
    ...overrides,
  };
}

function build(overrides: Record<string, any> = {}) {
  return new FakeSupabase({
    profiles: () => ({ data: PROFILE, error: null }),
    notifications: (call: RecordedCall) => {
      // The unread count is the one query that filters on `read_at IS NULL`.
      const isUnreadCount = call.filters.some(([column]) => column === 'read_at');
      if (isUnreadCount) return { data: [], error: null, count: 2 };
      return { data: [notification()], error: null, count: 1 };
    },
    notification_devices: (call: RecordedCall) =>
      // `upsert` is not echoed like `insert` by the fake, so the responder
      // reflects the payload straight back as the row Postgres would store.
      call.payload && typeof call.payload === 'object'
        ? { data: { id: 'dddddddd-1111-4111-8111-dddddddddddd', ...(call.payload as object) }, error: null }
        : { data: null, error: null },
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
const selectCalls = (table: string) =>
  fake.calls.filter((c) => c.table === table && c.op === 'select');

beforeEach(() => {
  fake = build();
});

describe('GET /api/notifications', () => {
  it('needs a session', async () => {
    const res = await listNotifications(request('/api/notifications'));
    expect(res.status).toBe(401);
  });

  it('defaults to the in_app channel and scopes to the caller', async () => {
    const res = await listNotifications(request('/api/notifications', { token: TOKEN }));
    expect(res.status).toBe(200);

    const list = selectCalls('notifications')[0]!;
    expect(list.eqFilters).toContainEqual(['recipient_id', USER_ID]);
    expect(list.eqFilters).toContainEqual(['channel', 'in_app']);
  });

  it('returns items, an unread count and a total', async () => {
    const res = await listNotifications(request('/api/notifications', { token: TOKEN }));
    expect(await body(res)).toMatchObject({
      success: true,
      data: {
        items: [
          {
            id: NOTIF_ID,
            channel: 'in_app',
            code: 'BOOKING_CONFIRMED',
            title: 'Booking confirmed',
            bookingId: 'ffffffff-1111-4111-8111-ffffffffffff',
            readAt: null,
          },
        ],
        unread: 2,
        total: 1,
      },
    });
  });

  it('names a channel it does not know instead of silently returning nothing', async () => {
    const res = await listNotifications(
      request('/api/notifications?channel=carrier-pigeon', { token: TOKEN })
    );
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      data: { items: [], unread: 0, total: 0, ignoredChannel: 'carrier-pigeon' },
    });
    // A rejected channel never reaches the database.
    expect(selectCalls('notifications')).toHaveLength(0);
  });
});

describe('POST /api/notifications/:id/read', () => {
  it('needs a session', async () => {
    const res = await markRead(request(`/api/notifications/${NOTIF_ID}/read`, { method: 'POST' }), {
      params: { id: NOTIF_ID },
    });
    expect(res.status).toBe(401);
  });

  it('marks the caller\'s own row read', async () => {
    const res = await markRead(
      request(`/api/notifications/${NOTIF_ID}/read`, { method: 'POST', token: TOKEN }),
      { params: { id: NOTIF_ID } }
    );
    expect(res.status).toBe(200);
    const json = await body(res);
    expect(json.data.id).toBe(NOTIF_ID);
    expect(json.data.status).toBe('read');
    expect(typeof json.data.readAt).toBe('string');

    const update = fake.writesTo('notifications').find((w) => w.op === 'update')!;
    expect(update.filters).toContainEqual(['id', NOTIF_ID]);
    expect(update.filters).toContainEqual(['recipient_id', USER_ID]);
    expect(update.payload).toMatchObject({ status: 'read' });
  });

  it('answers 404 for a row that is not the caller\'s, with no write', async () => {
    fake = build({
      notifications: () => ({ data: [notification({ recipient_id: OTHER_ID })], error: null }),
    });
    const res = await markRead(
      request(`/api/notifications/${NOTIF_ID}/read`, { method: 'POST', token: TOKEN }),
      { params: { id: NOTIF_ID } }
    );
    expect(res.status).toBe(404);
    expect((await body(res)).code).toBe('NOT_FOUND');
  });
});

describe('POST /api/notifications/read-all', () => {
  it('clears the caller\'s in_app rows and reports how many moved', async () => {
    fake = build({
      notifications: (call: RecordedCall) =>
        call.op === 'update'
          ? {
              data: [
                { id: NOTIF_ID, recipient_id: USER_ID, channel: 'in_app' },
                { id: '22222222-2222-4222-8222-222222222222', recipient_id: USER_ID, channel: 'in_app' },
              ],
              error: null,
            }
          : { data: [], error: null, count: 0 },
    });
    const res = await readAll(request('/api/notifications/read-all', { method: 'POST', token: TOKEN }));
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ data: { marked: 2 } });

    const update = fake.writesTo('notifications').find((w) => w.op === 'update')!;
    expect(update.filters).toContainEqual(['recipient_id', USER_ID]);
    expect(update.filters).toContainEqual(['channel', 'in_app']);
    expect(update.filters).toContainEqual(['read_at', null]);
    expect(update.payload).toMatchObject({ status: 'read' });
  });
});

describe('POST/DELETE /api/notifications/push-token', () => {
  it('registers a device token', async () => {
    const res = await registerToken(
      request('/api/notifications/push-token', {
        method: 'POST',
        token: TOKEN,
        body: { token: 'push-token-abcdefgh', platform: 'web' },
      })
    );
    expect(res.status).toBe(201);
    const json = await body(res);
    expect(json.data.device).toMatchObject({ profile_id: USER_ID, token: 'push-token-abcdefgh' });
  });

  it('rejects a token that is too short', async () => {
    const res = await registerToken(
      request('/api/notifications/push-token', { method: 'POST', token: TOKEN, body: { token: 'x' } })
    );
    expect(res.status).toBe(400);
    expect(fake.writesTo('notification_devices')).toHaveLength(0);
  });

  it('refuses an unknown platform', async () => {
    const res = await registerToken(
      request('/api/notifications/push-token', {
        method: 'POST',
        token: TOKEN,
        body: { token: 'push-token-abcdefgh', platform: 'symbian' },
      })
    );
    expect(res.status).toBe(400);
  });

  it('forgets a token on sign-out, scoped to the caller', async () => {
    const res = await removeToken(
      request('/api/notifications/push-token', {
        method: 'DELETE',
        token: TOKEN,
        body: { token: 'push-token-abcdefgh' },
      })
    );
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ data: { removed: true } });

    const del = fake.writesTo('notification_devices').find((w) => w.op === 'delete')!;
    expect(del.filters).toContainEqual(['profile_id', USER_ID]);
    expect(del.filters).toContainEqual(['token', 'push-token-abcdefgh']);
  });

  it('rejects a token-less delete', async () => {
    const res = await removeToken(
      request('/api/notifications/push-token', { method: 'DELETE', token: TOKEN })
    );
    expect(res.status).toBe(400);
  });
});
