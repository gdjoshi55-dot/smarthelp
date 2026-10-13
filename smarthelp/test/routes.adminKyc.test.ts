import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';

import { GET as getKyc } from '@/app/api/admin/professionals/[id]/kyc/route';
import { POST as bulkDecision } from '@/app/api/admin/professionals/kyc/bulk-decision/route';
import { POST as suspend } from '@/app/api/admin/professionals/[id]/suspend/route';

/**
 * Wave B's three KYC/suspension endpoints.
 *
 * The properties that matter and cannot be seen in a screenshot:
 *
 *   The signed URL is the only door. `kyc-documents` has no select policy, so
 *   the review route minting a URL for a document is the entire access grant —
 *   the test asserts the bucket and the exact path, not that a string came back.
 *
 *   The batch is the single path repeated. `bulk-decision` calls the same
 *   `kyc_document_decision` RPC once per pending document and audits each, so a
 *   batch and a careful one-at-a-time review cannot disagree about a roll-up.
 *
 *   Suspension is capability-gated. `pro.suspend` is admin-only, so ops can read
 *   the roster but not sign someone out of the marketplace.
 */

const AUTH_USER_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'staff-token';
const PROF_ID = 'dddddddd-0001-4111-8111-dddddddddd01';
const PROFILE_ID = 'eeeeeeee-0001-4111-8111-eeeeeeeeee01';
const DOC_A = 'dddd1111-0001-4111-8111-ddddddddd101';
const DOC_B = 'dddd1111-0002-4111-8111-ddddddddd102';
const MISSING_ID = 'dddddddd-0009-4111-8111-dddddddddd09';

let fake: FakeSupabase;
let staffRole: 'admin' | 'ops' | 'support' = 'admin';

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

function staffProfile() {
  return { id: AUTH_USER_ID, role: staffRole, status: 'active', full_name: 'Admin One' };
}

function documentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_A,
    professional_id: PROF_ID,
    doc_type: 'aadhaar_front',
    file_path: `${PROF_ID}/aadhaar_front/front.jpg`,
    status: 'submitted',
    rejection_reason: null,
    reviewed_by: null,
    reviewed_at: null,
    expires_at: null,
    created_at: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

function professionalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROF_ID,
    profile_id: PROFILE_ID,
    employee_code: 'EMP-1',
    verification_status: 'submitted',
    availability_status: 'online',
    is_available_today: true,
    suspended_reason: null,
    created_at: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

function build(overrides: Record<string, any> = {}) {
  return new FakeSupabase(
    {
      profiles: () => ({
        data: [staffProfile(), { id: PROFILE_ID, role: 'professional', status: 'active', full_name: 'Ravi Kumar' }],
        error: null,
      }),
      professionals: () => ({
        data: [
          professionalRow(),
          professionalRow({ id: 'dddddddd-0002-4111-8111-dddddddddd02', profile_id: 'eeeeeeee-0002-4111-8111-eeeeeeeeee02' }),
        ],
        error: null,
      }),
      professional_documents: () => ({
        data: [
          documentRow(),
          documentRow({ id: DOC_B, doc_type: 'pan', file_path: `${PROF_ID}/pan/pan.jpg` }),
        ],
        error: null,
      }),
      professional_skills: () => ({
        data: [{ service_id: 'aaaaaaaa-0001-4111-8111-aaaaaaaaaa01', proficiency: 4 }],
        error: null,
      }),
      ...overrides,
    },
    {
      kyc_document_decision: () => ({ data: 'verified', error: null }),
      write_audit: () => ({ data: 'audit-1', error: null }),
      ...(overrides.rpcs ?? {}),
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
  fake = build();
  staffRole = 'admin';
});

describe('GET /api/admin/professionals/:id/kyc', () => {
  it('needs a session', async () => {
    const res = await getKyc(request(`/api/admin/professionals/${PROF_ID}/kyc`), {
      params: { id: PROF_ID },
    });
    expect(res.status).toBe(401);
  });

  it('404s an unknown professional and mints no URL', async () => {
    const res = await getKyc(request(`/api/admin/professionals/${MISSING_ID}/kyc`, { token: TOKEN }), {
      params: { id: MISSING_ID },
    });
    expect(res.status).toBe(404);
    expect(fake.signedReads).toHaveLength(0);
  });

  it('returns each document with a signed read URL for the private bucket', async () => {
    const res = await getKyc(request(`/api/admin/professionals/${PROF_ID}/kyc`, { token: TOKEN }), {
      params: { id: PROF_ID },
    });
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data.documents).toHaveLength(2);
    expect(body.data.documents[0].signedUrl).toContain('/object/sign/kyc-documents/');

    expect(fake.signedReads.map((s) => [s.bucket, s.path])).toEqual([
      ['kyc-documents', `${PROF_ID}/aadhaar_front/front.jpg`],
      ['kyc-documents', `${PROF_ID}/pan/pan.jpg`],
    ]);
  });
});

describe('POST /api/admin/professionals/kyc/bulk-decision', () => {
  it('needs a session', async () => {
    const res = await bulkDecision(request('/api/admin/professionals/kyc/bulk-decision', { method: 'POST' }));
    expect(res.status).toBe(401);
  });

  it('refuses an empty selection', async () => {
    const res = await bulkDecision(
      request('/api/admin/professionals/kyc/bulk-decision', {
        method: 'POST',
        token: TOKEN,
        body: { professionalIds: [], verdict: 'verified' },
      })
    );
    expect(res.status).toBe(422);
  });

  it('refuses a rejection with no reason', async () => {
    const res = await bulkDecision(
      request('/api/admin/professionals/kyc/bulk-decision', {
        method: 'POST',
        token: TOKEN,
        body: { professionalIds: [PROF_ID], verdict: 'rejected', note: '' },
      })
    );
    expect(res.status).toBe(422);
  });

  it('verifies every pending document through the same RPC, auditing each', async () => {
    const res = await bulkDecision(
      request('/api/admin/professionals/kyc/bulk-decision', {
        method: 'POST',
        token: TOKEN,
        body: { professionalIds: [PROF_ID], verdict: 'verified' },
      })
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data.results[0]).toMatchObject({
      professionalId: PROF_ID,
      documentsProcessed: 2,
      verificationStatus: 'verified',
    });

    const decisions = fake.rpcCalls.filter((c) => c.fn === 'kyc_document_decision');
    expect(decisions).toHaveLength(2);
    expect(decisions.map((c) => c.args.p_document_id)).toEqual([DOC_A, DOC_B]);
    // One audit per document, marked as a batch.
    expect(fake.rpcCalls.filter((c) => c.fn === 'write_audit')).toHaveLength(2);
  });

  it('carries the reviewer reason onto each rejected document', async () => {
    const res = await bulkDecision(
      request('/api/admin/professionals/kyc/bulk-decision', {
        method: 'POST',
        token: TOKEN,
        body: { professionalIds: [PROF_ID], verdict: 'rejected', note: 'blurry' },
      })
    );
    expect(res.status).toBe(200);

    const writes = fake.writesTo('professional_documents');
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(write.payload).toMatchObject({ rejection_reason: 'blurry' });
    }
  });
});

describe('POST /api/admin/professionals/:id/suspend', () => {
  it('forbids ops — no pro.suspend', async () => {
    staffRole = 'ops';
    const res = await suspend(
      request(`/api/admin/professionals/${PROF_ID}/suspend`, {
        method: 'POST',
        token: TOKEN,
        body: { reason: 'policy' },
      }),
      { params: { id: PROF_ID } }
    );
    expect(res.status).toBe(403);
    expect(fake.writesTo('profiles')).toHaveLength(0);
  });

  it('needs a reason to suspend', async () => {
    const res = await suspend(
      request(`/api/admin/professionals/${PROF_ID}/suspend`, {
        method: 'POST',
        token: TOKEN,
        body: {},
      }),
      { params: { id: PROF_ID } }
    );
    expect(res.status).toBe(400);
  });

  it('suspends the professional row and the profile, and audits', async () => {
    const res = await suspend(
      request(`/api/admin/professionals/${PROF_ID}/suspend`, {
        method: 'POST',
        token: TOKEN,
        body: { reason: 'repeated no-shows' },
      }),
      { params: { id: PROF_ID } }
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ suspended: true, profileStatus: 'suspended' });

    const proWrite = fake.writesTo('professionals')[0];
    expect(proWrite.payload).toMatchObject({
      suspended_reason: 'repeated no-shows',
      availability_status: 'offline',
      is_available_today: false,
    });

    const profileWrite = fake.writesTo('profiles')[0];
    expect(profileWrite.payload).toEqual({ status: 'suspended' });
    expect(profileWrite.eqFilters).toContainEqual(['id', PROFILE_ID]);

    expect(fake.rpcCalls.some((c) => c.fn === 'write_audit')).toBe(true);
  });

  it('reactivates without a reason', async () => {
    const res = await suspend(
      request(`/api/admin/professionals/${PROF_ID}/suspend`, {
        method: 'POST',
        token: TOKEN,
        body: { suspended: false },
      }),
      { params: { id: PROF_ID } }
    );
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ suspended: false, profileStatus: 'active' });

    expect(fake.writesTo('professionals')[0].payload).toMatchObject({ suspended_reason: null });
    expect(fake.writesTo('profiles')[0].payload).toEqual({ status: 'active' });
  });
});
