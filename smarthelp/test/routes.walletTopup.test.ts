import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';

import { POST as postTopup } from '@/app/api/wallet/topup/route';

/**
 * POST /api/wallet/topup (§25.8).
 *
 * v1 is promo/ops credit only, so the route is a staff lever, not a card
 * checkout: `wallet.credit` gates it, the write goes through `creditWallet`
 * (and so `apply_wallet_delta`), and every accepted grant is audited. These
 * tests pin the gate, the amount rule and the single write path.
 */

const AUTH_USER_ID = '00000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000002';
const WALLET_ID = '00000000-0000-4000-8000-0000000000aa';
const TOKEN = 'staff-token';

let fake: FakeSupabase;
let staffRole: 'customer' | 'ops' | 'support' | 'admin' | 'super_admin' = 'admin';
let customers: { id: string }[] = [{ id: CUSTOMER_ID }];

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

function build() {
  return new FakeSupabase(
    {
      profiles: () => ({
        data: [
          {
            id: AUTH_USER_ID,
            role: staffRole,
            status: 'active',
            full_name: 'Staff One',
            phone: null,
            email: null,
          },
        ],
        error: null,
      }),
      customers: () => ({ data: customers, error: null }),
    },
    {
      get_or_create_wallet: () => ({ data: WALLET_ID, error: null }),
      apply_wallet_delta: () => ({ data: '750.00', error: null }),
      write_audit: () => ({ data: 'audit-1', error: null }),
    }
  );
}

function request(body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  return new Request('http://localhost/api/wallet/topup', {
    method: 'POST',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const json = async (res: Response) => (await res.json()) as any;

beforeEach(() => {
  staffRole = 'admin';
  customers = [{ id: CUSTOMER_ID }];
  fake = build();
});

describe('POST /api/wallet/topup', () => {
  it('needs a session', async () => {
    const res = await postTopup(request({ customerId: CUSTOMER_ID, amount: 500 }, null));
    expect(res.status).toBe(401);
  });

  it('refuses a role without wallet.credit', async () => {
    staffRole = 'customer';
    const res = await postTopup(request({ customerId: CUSTOMER_ID, amount: 500 }));
    expect(res.status).toBe(403);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('credits the wallet through the one ledger path and audits it', async () => {
    const res = await postTopup(request({ customerId: CUSTOMER_ID, amount: 500, reason: 'Goodwill' }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.balance).toBe(750);
    expect(body.data.credited).toBe(500);

    const delta = fake.rpcCalls.find((c) => c.fn === 'apply_wallet_delta');
    expect(delta?.args).toMatchObject({ p_type: 'credit', p_amount: '500.00' });
    expect(String(delta?.args.p_ref)).toMatch(/^topup:/);

    const audits = fake.rpcCalls.filter((c) => c.fn === 'write_audit');
    expect(audits).toHaveLength(1);
  });

  it('refuses a non-positive amount before touching the wallet', async () => {
    const res = await postTopup(request({ customerId: CUSTOMER_ID, amount: 0 }));
    expect(res.status).toBe(400);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('404s an unknown customer, naming the field', async () => {
    customers = [];
    const res = await postTopup(request({ customerId: CUSTOMER_ID, amount: 500 }));
    expect(res.status).toBe(404);
    expect(fake.rpcCalls).toHaveLength(0);
  });
});
