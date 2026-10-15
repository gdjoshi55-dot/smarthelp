import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';

import { GET as listTickets } from '@/app/api/admin/support/route';
import { GET as getTicket, PATCH as patchTicket } from '@/app/api/admin/support/[id]/route';
import { POST as postMessage } from '@/app/api/admin/support/[id]/messages/route';

const AUTH_USER_ID = '00000000-0000-4000-8000-000000000001';
const RAISER_ID = 'aaaaaaaa-0001-4111-8111-aaaaaaaaaa01';
const TICKET_ID = 'bbbbbbbb-0001-4111-8111-bbbbbbbbbb01';
const MISSING_ID = 'bbbbbbbb-0009-4111-8111-bbbbbbbbbb09';
const BOOKING_ID = 'cccccccc-0001-4111-8111-cccccccccc01';
const TOKEN = 'staff-token';

let fake: FakeSupabase;
let staffRole: 'ops' | 'support' | 'admin' | 'super_admin' | 'customer' = 'support';

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

function ticketRow(overrides: Record<string, any> = {}) {
  return {
    id: TICKET_ID,
    booking_id: BOOKING_ID,
    raised_by: RAISER_ID,
    subject: 'Professional arrived late',
    category: 'delivery',
    priority: 'high',
    status: 'open',
    assigned_to: null,
    resolution: null,
    resolved_at: null,
    created_at: '2026-06-01T10:00:00.000Z',
    updated_at: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

function build() {
  return new FakeSupabase(
    {
      profiles: () => ({
        data: [
          { id: AUTH_USER_ID, role: staffRole, status: 'active', full_name: 'Support One', phone: null, email: null },
          { id: RAISER_ID, full_name: 'Ravi Customer' },
        ],
        error: null,
      }),
      support_tickets: () => ({ data: [ticketRow()], error: null }),
      support_messages: () => ({
        data: [
          {
            id: 'dddddddd-0001-4111-8111-dddddddddd01',
            ticket_id: TICKET_ID,
            author_profile_id: RAISER_ID,
            body: 'They were 40 minutes late.',
            is_internal: false,
            created_at: '2026-06-01T10:05:00.000Z',
          },
        ],
        error: null,
      }),
      bookings: () => ({ data: [{ id: BOOKING_ID, booking_number: 'SH-1001' }], error: null }),
    },
    {
      write_audit: () => ({ data: 'audit-1', error: null }),
    }
  );
}

function request(url: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body) headers['content-type'] = 'application/json';
  return new Request(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

const json = async (res: Response) => (await res.json()) as any;

beforeEach(() => {
  staffRole = 'support';
  fake = build();
});

describe('GET /api/admin/support', () => {
  it('needs a session', async () => {
    const res = await listTickets(request('/api/admin/support'));
    expect(res.status).toBe(401);
  });

  it('forbids a customer', async () => {
    staffRole = 'customer';
    const res = await listTickets(request('/api/admin/support', { token: TOKEN }));
    expect(res.status).toBe(403);
  });

  it('returns the queue, resolving names and the booking number', async () => {
    const res = await listTickets(request('/api/admin/support', { token: TOKEN }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.tickets).toHaveLength(1);
    expect(body.data.tickets[0].subject).toBe('Professional arrived late');
    expect(body.data.tickets[0].raisedByName).toBe('Ravi Customer');
    expect(body.data.tickets[0].bookingNumber).toBe('SH-1001');
    expect(body.data.total).toBe(1);
  });
});

describe('GET /api/admin/support/:id', () => {
  it('404s a ticket that does not exist', async () => {
    const res = await getTicket(request(`/api/admin/support/${MISSING_ID}`, { token: TOKEN }), {
      params: { id: MISSING_ID },
    });
    expect(res.status).toBe(404);
  });

  it('returns the ticket and its thread', async () => {
    const res = await getTicket(request(`/api/admin/support/${TICKET_ID}`, { token: TOKEN }), {
      params: { id: TICKET_ID },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.ticket.subject).toBe('Professional arrived late');
    expect(body.data.messages).toHaveLength(1);
    expect(body.data.messages[0].authorName).toBe('Ravi Customer');
  });
});

describe('PATCH /api/admin/support/:id', () => {
  it('forbids a customer — ticket.write is required', async () => {
    staffRole = 'customer';
    const res = await patchTicket(
      request(`/api/admin/support/${TICKET_ID}`, { method: 'PATCH', token: TOKEN, body: { status: 'resolved' } }),
      { params: { id: TICKET_ID } }
    );
    expect(res.status).toBe(403);
    expect(fake.calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('404s a ticket that does not exist, and writes nothing', async () => {
    const res = await patchTicket(
      request(`/api/admin/support/${MISSING_ID}`, { method: 'PATCH', token: TOKEN, body: { status: 'resolved' } }),
      { params: { id: MISSING_ID } }
    );
    expect(res.status).toBe(404);
    expect(fake.calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('rejects an unknown status', async () => {
    const res = await patchTicket(
      request(`/api/admin/support/${TICKET_ID}`, { method: 'PATCH', token: TOKEN, body: { status: 'nonsense' } }),
      { params: { id: TICKET_ID } }
    );
    expect(res.status).toBe(400);
  });

  it('resolves a ticket, stamping resolved_at, and audits it', async () => {
    const res = await patchTicket(
      request(`/api/admin/support/${TICKET_ID}`, {
        method: 'PATCH',
        token: TOKEN,
        body: { status: 'resolved', resolution: 'Goodwill credit issued' },
      }),
      { params: { id: TICKET_ID } }
    );
    expect(res.status).toBe(200);
    const updated = fake.calls.find((c) => c.op === 'update' && c.table === 'support_tickets');
    const payload = updated?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({ status: 'resolved', resolution: 'Goodwill credit issued' });
    expect(typeof payload?.resolved_at).toBe('string');
    expect(fake.rpcCalls.some((c) => c.fn === 'write_audit')).toBe(true);
  });
});

describe('POST /api/admin/support/:id/messages', () => {
  it('forbids a customer', async () => {
    staffRole = 'customer';
    const res = await postMessage(
      request(`/api/admin/support/${TICKET_ID}/messages`, { method: 'POST', token: TOKEN, body: { body: 'Hi' } }),
      { params: { id: TICKET_ID } }
    );
    expect(res.status).toBe(403);
  });

  it('404s a ticket that does not exist', async () => {
    const res = await postMessage(
      request(`/api/admin/support/${MISSING_ID}/messages`, { method: 'POST', token: TOKEN, body: { body: 'Hi' } }),
      { params: { id: MISSING_ID } }
    );
    expect(res.status).toBe(404);
    expect(fake.calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('rejects an empty body', async () => {
    const res = await postMessage(
      request(`/api/admin/support/${TICKET_ID}/messages`, { method: 'POST', token: TOKEN, body: { body: '' } }),
      { params: { id: TICKET_ID } }
    );
    expect(res.status).toBe(400);
  });

  it('stores an internal note and audits the note action', async () => {
    const res = await postMessage(
      request(`/api/admin/support/${TICKET_ID}/messages`, {
        method: 'POST',
        token: TOKEN,
        body: { body: 'Called the customer', isInternal: true },
      }),
      { params: { id: TICKET_ID } }
    );
    expect(res.status).toBe(201);
    const inserted = fake.calls.find((c) => c.op === 'insert' && c.table === 'support_messages');
    const payload = inserted?.payload as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({ ticket_id: TICKET_ID, body: 'Called the customer', is_internal: true });
    const audited = fake.rpcCalls.find((c) => c.fn === 'write_audit');
    expect(audited?.args.p_action).toBe('support.note');
  });
});
