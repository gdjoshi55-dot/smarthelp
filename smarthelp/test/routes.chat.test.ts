import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase, type RecordedCall } from './helpers/fakeSupabase';
import { GET as bookingChat } from '@/app/api/bookings/[id]/chat/route';
import {
  GET as threadMessages,
  POST as postMessage,
} from '@/app/api/chat/threads/[id]/messages/route';

/**
 * Booking chat (§24.11, §25.9, §27.1).
 *
 * The chat is the most privacy-sensitive surface in the phase: it carries free
 * text between two people, and the service-role reads behind it would happily
 * hand a stranger the whole thread. So the tests are about the gate:
 *
 *   * A booking with no assigned professional has no chat — the same 404 a
 *     stranger gets, so the endpoint is not a way to discover which bookings
 *     exist.
 *   * Only the two participants may post; staff may read and get `canPost:
 *     false`; a stranger gets a 404 with zero writes.
 *   * A `system` message is server-only, so a client that asks for one is
 *     refused rather than trusted.
 */

const CUSTOMER_PROFILE = '00000000-0000-4000-8000-0000000000c1';
const PRO_PROFILE = '00000000-0000-4000-8000-0000000000a1';
const STRANGER_PROFILE = '00000000-0000-4000-8000-0000000000ff';
const ADMIN_PROFILE = '00000000-0000-4000-8000-0000000000ad';
const CUSTOMER_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const PROF_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BOOKING_ID = 'ffffffff-1111-4111-8111-ffffffffffff';
const THREAD_ID = '1a2b3c4d-1111-4111-8111-1a2b3c4d5e6f';
const TOKEN = 'session-token';

let fake: FakeSupabase;
let callerId: string;
let callerRole: string;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

function profileRow() {
  return {
    id: callerId,
    role: callerRole,
    status: 'active',
    full_name: 'Caller',
    phone: '+919876543210',
    email: null,
  };
}

function threadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: THREAD_ID,
    booking_id: BOOKING_ID,
    customer_id: CUSTOMER_ID,
    professional_id: PROF_ID,
    last_message_at: null,
    closed_at: null,
    created_at: '2026-06-01T12:00:00.000Z',
    ...overrides,
  };
}

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '2b3c4d5e-1111-4111-8111-2b3c4d5e6f70',
    thread_id: THREAD_ID,
    sender_id: CUSTOMER_PROFILE,
    kind: 'text',
    body: 'Hi, on my way?',
    image_path: null,
    read_at: null,
    created_at: '2026-06-01T12:05:00.000Z',
    ...overrides,
  };
}

function build(overrides: Record<string, any> = {}) {
  return new FakeSupabase({
    // `requireAuth` filters by id and wants the profile object; the message
    // list uses `.in(..)` and wants rows with names. The filter shape tells
    // the two apart.
    profiles: (call: RecordedCall) =>
      call.eqFilters.some(([column]) => column === 'id')
        ? { data: profileRow(), error: null }
        : {
            data: [
              { id: CUSTOMER_PROFILE, full_name: 'Asha Rao' },
              { id: PRO_PROFILE, full_name: 'Ravi Kumar' },
            ],
            error: null,
          },
    bookings: () => ({
      data: {
        id: BOOKING_ID,
        booking_number: 'SH-20260601-00001',
        customer_id: CUSTOMER_ID,
        professional_id: PROF_ID,
      },
      error: null,
    }),
    customers: () => ({ data: { profile_id: CUSTOMER_PROFILE }, error: null }),
    professionals: () => ({ data: { profile_id: PRO_PROFILE }, error: null }),
    chat_threads: () => ({ data: threadRow(), error: null }),
    chat_messages: (call: RecordedCall) =>
      call.op === 'insert' ? { data: [], error: null } : { data: [messageRow()], error: null },
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
  callerId = CUSTOMER_PROFILE;
  callerRole = 'customer';
  fake = build();
});

describe('GET /api/bookings/:id/chat', () => {
  it('needs a session', async () => {
    const res = await bookingChat(request(`/api/bookings/${BOOKING_ID}/chat`), {
      params: { id: BOOKING_ID },
    });
    expect(res.status).toBe(401);
  });

  it('returns the thread and history to a participant, with canPost true', async () => {
    const res = await bookingChat(
      request(`/api/bookings/${BOOKING_ID}/chat`, { token: TOKEN }),
      { params: { id: BOOKING_ID } }
    );
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      success: true,
      data: {
        thread: {
          id: THREAD_ID,
          bookingId: BOOKING_ID,
          bookingNumber: 'SH-20260601-00001',
          customerProfileId: CUSTOMER_PROFILE,
          professionalProfileId: PRO_PROFILE,
        },
        canPost: true,
      },
    });
  });

  it('gives a stranger the same 404 as a booking with no chat, and creates no thread', async () => {
    callerId = STRANGER_PROFILE;
    const res = await bookingChat(
      request(`/api/bookings/${BOOKING_ID}/chat`, { token: TOKEN }),
      { params: { id: BOOKING_ID } }
    );
    expect(res.status).toBe(404);
    expect((await body(res)).code).toBe('NOT_FOUND');
    expect(fake.writesTo('chat_threads')).toHaveLength(0);
  });

  it('404s a booking with no assigned professional', async () => {
    fake = build({
      bookings: () => ({
        data: {
          id: BOOKING_ID,
          booking_number: 'SH-20260601-00001',
          customer_id: CUSTOMER_ID,
          professional_id: null,
        },
        error: null,
      }),
    });
    const res = await bookingChat(
      request(`/api/bookings/${BOOKING_ID}/chat`, { token: TOKEN }),
      { params: { id: BOOKING_ID } }
    );
    expect(res.status).toBe(404);
    expect(fake.writesTo('chat_threads')).toHaveLength(0);
  });
});

describe('GET /api/chat/threads/:id/messages', () => {
  it('lets staff read but not post', async () => {
    callerId = ADMIN_PROFILE;
    callerRole = 'admin';
    const res = await threadMessages(
      request(`/api/chat/threads/${THREAD_ID}/messages`, { token: TOKEN }),
      { params: { id: THREAD_ID } }
    );
    expect(res.status).toBe(200);
    const json = await body(res);
    expect(json.data.canPost).toBe(false);
    expect(json.data.messages).toHaveLength(1);
    expect(json.data.messages[0].senderName).toBe('Asha Rao');
  });

  it('404s a stranger', async () => {
    callerId = STRANGER_PROFILE;
    const res = await threadMessages(
      request(`/api/chat/threads/${THREAD_ID}/messages`, { token: TOKEN }),
      { params: { id: THREAD_ID } }
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/chat/threads/:id/messages', () => {
  it('lets a participant post a text message', async () => {
    const res = await postMessage(
      request(`/api/chat/threads/${THREAD_ID}/messages`, {
        method: 'POST',
        token: TOKEN,
        body: { kind: 'text', body: 'I am outside.' },
      }),
      { params: { id: THREAD_ID } }
    );
    expect(res.status).toBe(201);
    const json = await body(res);
    expect(json.data.message).toMatchObject({ threadId: THREAD_ID, body: 'I am outside.' });

    const insert = fake.writesTo('chat_messages').find((w) => w.op === 'insert')!;
    expect(insert.payload).toMatchObject({
      thread_id: THREAD_ID,
      sender_id: CUSTOMER_PROFILE,
      kind: 'text',
      body: 'I am outside.',
    });
    // The thread's last_message_at moves in the same action.
    expect(fake.writesTo('chat_threads').find((w) => w.op === 'update')).toBeTruthy();
  });

  it('refuses staff, who may read but not speak', async () => {
    callerId = ADMIN_PROFILE;
    callerRole = 'admin';
    const res = await postMessage(
      request(`/api/chat/threads/${THREAD_ID}/messages`, {
        method: 'POST',
        token: TOKEN,
        body: { kind: 'text', body: 'admin says hi' },
      }),
      { params: { id: THREAD_ID } }
    );
    expect(res.status).toBe(403);
    expect(fake.writesTo('chat_messages')).toHaveLength(0);
  });

  it('refuses a client asking to write a system message', async () => {
    const res = await postMessage(
      request(`/api/chat/threads/${THREAD_ID}/messages`, {
        method: 'POST',
        token: TOKEN,
        body: { kind: 'system', body: 'status changed' },
      }),
      { params: { id: THREAD_ID } }
    );
    expect(res.status).toBe(403);
    expect(fake.writesTo('chat_messages')).toHaveLength(0);
  });

  it('rejects an empty text message', async () => {
    const res = await postMessage(
      request(`/api/chat/threads/${THREAD_ID}/messages`, {
        method: 'POST',
        token: TOKEN,
        body: { kind: 'text', body: '   ' },
      }),
      { params: { id: THREAD_ID } }
    );
    expect(res.status).toBe(400);
    expect(fake.writesTo('chat_messages')).toHaveLength(0);
  });

  it('refuses to post to a closed thread', async () => {
    fake = build({ chat_threads: () => ({ data: threadRow({ closed_at: '2026-06-02T10:00:00.000Z' }), error: null }) });
    const res = await postMessage(
      request(`/api/chat/threads/${THREAD_ID}/messages`, {
        method: 'POST',
        token: TOKEN,
        body: { kind: 'text', body: 'still there?' },
      }),
      { params: { id: THREAD_ID } }
    );
    expect(res.status).toBe(409);
    expect(fake.writesTo('chat_messages')).toHaveLength(0);
  });
});
