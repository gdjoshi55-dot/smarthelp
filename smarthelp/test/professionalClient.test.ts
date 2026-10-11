import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `lib/professionalClient.ts`, the browser's authenticated fetch wrapper for
 * every `/api/professionals/**` verb.
 *
 * This file exists for the same reason `test/bookingClient.test.ts` does: the
 * one bug the 489-green-test suite could not see was a browser client that sent
 * no `Authorization` header, because every route test built its own `Request`
 * with the header already attached. The guarantee here is stronger — every
 * runtime export is enumerated and called, so a verb added later without the
 * header is a red test rather than a production 401.
 */

const ACCESS_TOKEN = 'access-token-for-deepa';
const ID = 'b1b1b1b1-1111-4111-8111-111111111111';

const getSession = vi.fn();
let jsonResponse: unknown;

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSession(),
    },
  },
}));

import * as client from '@/lib/professionalClient';
import { ProfessionalApiError } from '@/lib/professionalClient';

/** One call per runtime export. Kept exhaustive by the coverage test below. */
const CALLS: Record<string, () => Promise<unknown>> = {
  fetchWorkingHours: () => client.fetchWorkingHours(),
  saveWorkingHours: () =>
    client.saveWorkingHours([{ weekday: 1, startTime: '09:00', endTime: '17:00' }]),
  fetchTimeOff: () => client.fetchTimeOff(),
  addTimeOff: () =>
    client.addTimeOff({ startsAt: '2026-10-09T09:00:00.000Z', endsAt: '2026-10-09T18:00:00.000Z' }),
  deleteTimeOff: () => client.deleteTimeOff(ID),
  fetchAvailability: () => client.fetchAvailability(),
  setAvailability: () => client.setAvailability(true),
  postLocation: () => client.postLocation({ lat: 12.9716, lng: 77.5946 }),
  fetchKyc: () => client.fetchKyc(),
  submitKycDocument: () =>
    client.submitKycDocument({ docType: 'selfie', filePath: `${ID}/selfie/a.jpg` }),
  requestKycUploadUrl: () =>
    client.requestKycUploadUrl({
      docType: 'selfie',
      filename: 'a.jpg',
      contentType: 'image/jpeg',
      size: 1024,
    }),
  fetchJobs: () => client.fetchJobs(),
  fetchOffers: () => client.fetchOffers(),
  acceptOffer: () => client.acceptOffer(ID),
  declineOffer: () => client.declineOffer(ID, 'Already on a job'),
  startJourney: () => client.startJourney(ID),
  arriveJob: () => client.arriveJob(ID, { lat: 12.9716, lng: 77.5946 }),
  verifyServiceOtp: () => client.verifyServiceOtp(ID, '1234'),
  completeJob: () => client.completeJob(ID),
  reportNoShow: () => client.reportNoShow(ID, 'Customer not reachable'),
};

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('no fetch was made');
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

function errorBody(code: string, message: string): unknown {
  return {
    success: false,
    error: message,
    code,
    requestId: 'server',
    timestamp: '2026-10-08T00:00:00.000Z',
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  getSession.mockReset();
  jsonResponse = { success: true, data: {} };
  getSession.mockResolvedValue({ data: { session: { access_token: ACCESS_TOKEN } } });
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => jsonResponse,
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the professional client', () => {
  it('enumerates every runtime export, so a new verb cannot hide', () => {
    const exported = Object.entries(client)
      .filter(([name, value]) => typeof value === 'function' && name !== 'ProfessionalApiError')
      .map(([name]) => name)
      .sort();
    expect(exported).toEqual(Object.keys(CALLS).sort());
  });

  it('attaches the caller\'s bearer token on every verb', async () => {
    for (const call of Object.values(CALLS)) await call();

    expect(fetchMock).toHaveBeenCalledTimes(Object.keys(CALLS).length);
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1]?.headers ?? {}) as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    }
  });

  it('attaches it on a read', async () => {
    await client.fetchOffers();
    expect(headersOf(lastCall().init).authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(lastCall().url).toBe('/api/professionals/offers');
  });

  it('reads the token per call, so a refreshed session is not a stale header', async () => {
    await client.fetchOffers();
    getSession.mockResolvedValue({ data: { session: { access_token: 'refreshed-token' } } });
    await client.fetchOffers();
    expect(headersOf(lastCall().init).authorization).toBe('Bearer refreshed-token');
  });

  it('sends no token when there is no session, and lets the route answer 401', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => errorBody('UNAUTHENTICATED', 'Please sign in to continue.'),
    });

    const error = (await client.fetchJobs().catch((e: unknown) => e)) as ProfessionalApiError;
    expect(error).toBeInstanceOf(ProfessionalApiError);
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(error.status).toBe(401);
    expect(headersOf(lastCall().init).authorization).toBeUndefined();
  });

  it('carries an offer collision through with its code intact', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => errorBody('ASSIGNMENT_TAKEN', 'Another professional took this job.'),
    });
    const error = (await client.acceptOffer(ID).catch((e: unknown) => e)) as ProfessionalApiError;
    expect(error.code).toBe('ASSIGNMENT_TAKEN');
    expect(error.status).toBe(409);
  });

  it('reports an unreachable server as a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const error = (await client.fetchJobs().catch((e: unknown) => e)) as ProfessionalApiError;
    expect(error).toBeInstanceOf(ProfessionalApiError);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.status).toBe(0);
  });

  it('keeps the method, body and content-type for a write', async () => {
    await client.declineOffer(ID, 'Already on a job');
    const { init, url } = lastCall();
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(headersOf(init)['content-type']).toBe('application/json');
    expect(url).toBe(`/api/professionals/offers/${ID}/decline`);
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'Already on a job' });
  });
});
