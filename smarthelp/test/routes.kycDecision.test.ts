import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase, fakeSupabase } from './helpers/fakeSupabase';
import { POST as decideKyc } from '@/app/api/admin/professionals/[id]/kyc/[docId]/decision/route';

/**
 * The KYC verdict endpoint (§24.5, P4-02, D2).
 *
 * The endpoint ships with no UI — Phase 6 builds the review queue on top of it —
 * so this file is the closest thing to a console: it drives the route with a
 * staff token and checks the two things that make the endpoint safe. First, the
 * trust boundary: a customer token is refused before anything is read or
 * written. Second, the verdict path: the document write and the roll-up both
 * happen through `kyc_document_decision`, and the action leaves an audit row.
 *
 * The route reads the professional's row through the service role, so the
 * important negative assertion is always `writesTo(...)` — a refusal that still
 * wrote would be the whole bug.
 */

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const TOKEN = 'admin-token';
const PROF_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_PROF_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const DOC_ID = 'dddddddd-1111-4111-8111-dddddddddddd';

let fake: FakeSupabase;

vi.mock('@/lib/supabaseServer', () => ({
  createServerClient: () => fakeSupabase(fake),
  createRequestClient: () => fakeSupabase(fake),
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

const PROFILE = {
  id: ADMIN_ID,
  role: 'admin',
  status: 'active',
  full_name: 'Ops Admin',
  phone: null,
  email: 'ops@smarthelp.test',
};

function document(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    professional_id: PROF_ID,
    doc_type: 'selfie',
    status: 'submitted',
    ...overrides,
  };
}

function build(overrides: Record<string, any> = {}, rpcs: Record<string, any> = {}) {
  return new FakeSupabase(
    {
      profiles: () => ({ data: PROFILE, error: null }),
      professional_documents: () => ({ data: document(), error: null }),
      ...overrides,
    },
    {
      kyc_document_decision: () => ({ data: 'verified', error: null }),
      ...rpcs,
    }
  );
}

function request(init: { body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return new Request(`http://localhost/api/admin/professionals/${PROF_ID}/kyc/${DOC_ID}/decision`, {
    method: 'POST',
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    headers,
  });
}

const params = { params: { id: PROF_ID, docId: DOC_ID } };
const body = async (res: Response) => (await res.json()) as any;

beforeEach(() => {
  fake = build();
});

describe('POST /api/admin/professionals/[id]/kyc/[docId]/decision', () => {
  it('refuses a customer token with zero writes', async () => {
    fake = build({ profiles: () => ({ data: { ...PROFILE, role: 'customer' }, error: null }) });
    const res = await decideKyc(request({ body: { verdict: 'verified' }, token: TOKEN }), params);
    const json = await body(res);
    expect(res.status).toBe(403);
    expect(json.code).toBe('FORBIDDEN');
    expect(fake.writesTo('professional_documents')).toHaveLength(0);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('needs a session', async () => {
    const res = await decideKyc(request({ body: { verdict: 'verified' } }), params);
    expect(res.status).toBe(401);
  });

  it('applies the verdict through the roll-up RPC and audits it', async () => {
    const res = await decideKyc(request({ body: { verdict: 'verified' }, token: TOKEN }), params);
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.verificationStatus).toBe('verified');

    const decision = fake.rpcCalls.find((c) => c.fn === 'kyc_document_decision');
    expect(decision?.args).toEqual({
      p_document_id: DOC_ID,
      p_verdict: 'verified',
      p_admin: ADMIN_ID,
    });

    const audited = fake.rpcCalls.find((c) => c.fn === 'write_audit');
    expect(audited).toBeDefined();
    expect(audited?.args).toMatchObject({ p_entity_type: 'professional_document', p_entity_id: DOC_ID });
  });

  it('422s an invalid verdict without touching the database', async () => {
    const res = await decideKyc(request({ body: { verdict: 'maybe' }, token: TOKEN }), params);
    const json = await body(res);
    expect(res.status).toBe(422);
    expect(json.code).toBe('VALIDATION_ERROR');
    expect(fake.rpcCalls).toHaveLength(0);
    expect(fake.writesTo('professional_documents')).toHaveLength(0);
  });

  it('404s a document that is not on the named professional', async () => {
    fake = build({
      professional_documents: () => ({ data: document({ professional_id: OTHER_PROF_ID }), error: null }),
    });
    const res = await decideKyc(request({ body: { verdict: 'verified' }, token: TOKEN }), params);
    const json = await body(res);
    expect(res.status).toBe(404);
    expect(json.code).toBe('NOT_FOUND');
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it('stores the reviewer reason when a document is rejected', async () => {
    fake = build({}, { kyc_document_decision: () => ({ data: 'rejected', error: null }) });
    const res = await decideKyc(
      request({ body: { verdict: 'rejected', note: 'Photo is too blurry' }, token: TOKEN }),
      params
    );
    const json = await body(res);
    expect(res.status).toBe(200);
    expect(json.data.verificationStatus).toBe('rejected');

    const note = fake
      .writesTo('professional_documents')
      .find((w) => w.payload && (w.payload as any).rejection_reason);
    expect(note?.payload).toEqual({ rejection_reason: 'Photo is too blurry' });
  });
});
