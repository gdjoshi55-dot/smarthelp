import { describe, expect, it } from 'vitest';
import { ApiHttpError, err, handle, ok, readApiError, validationError } from '@/lib/api';

const request = (body?: unknown) =>
  new Request('http://localhost/api/test', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('ok', () => {
  it('wraps data in the success envelope', async () => {
    const res = ok({ id: 7 });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, data: { id: 7 } });
  });

  it('honours an explicit status', () => {
    expect(ok({}, 201).status).toBe(201);
  });
});

describe('err', () => {
  it('maps every code to the documented status', () => {
    expect(err('VALIDATION_ERROR', 'x').status).toBe(400);
    expect(err('UNAUTHENTICATED', 'x').status).toBe(401);
    expect(err('FORBIDDEN', 'x').status).toBe(403);
    expect(err('NOT_FOUND', 'x').status).toBe(404);
    expect(err('INVALID_STATE', 'x').status).toBe(409);
    expect(err('PAYMENT_FAILED', 'x').status).toBe(402);
    expect(err('NO_SLOT_AVAILABLE', 'x').status).toBe(422);
    expect(err('OTP_LOCKED', 'x').status).toBe(429);
    expect(err('RATE_LIMITED', 'x').status).toBe(429);
    expect(err('INTERNAL_ERROR', 'x').status).toBe(500);
  });

  it('lets a route override the status', () => {
    expect(err('INTERNAL_ERROR', 'x', 502).status).toBe(502);
  });

  it('always carries a code, a message and a timestamp', async () => {
    const body = await err('NOT_FOUND', 'No such booking').json();
    expect(body).toMatchObject({ success: false, error: 'No such booking', code: 'NOT_FOUND' });
    expect(typeof body.timestamp).toBe('string');
  });
});

describe('validationError', () => {
  it('nests the per-field copy under details.fields', async () => {
    const body = await validationError('Check the form', { phone: 'Bad number' }).json();
    expect(body.details.fields).toEqual({ phone: 'Bad number' });
  });
});

describe('ApiHttpError', () => {
  it('defaults its status from the code', () => {
    expect(new ApiHttpError('FORBIDDEN', 'no').status).toBe(403);
  });

  it('lets the thrower override the status', () => {
    expect(new ApiHttpError('VALIDATION_ERROR', 'no', 422).status).toBe(422);
  });
});

describe('handle', () => {
  it('passes a thrown ApiHttpError through with its code, status and details', async () => {
    const res = await handle(request(), 'test.route', async () => {
      throw new ApiHttpError('FORBIDDEN', 'Not yours.', 403, { field: 'booking_id' });
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      code: 'FORBIDDEN',
      error: 'Not yours.',
      details: { field: 'booking_id' },
    });
  });

  it('turns an unexpected throw into a generic 500 with no internals leaked', async () => {
    const res = await handle(request(), 'test.route', async () => {
      throw new Error('connection string postgres://user:hunter2@db/prod blew up');
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.error).not.toContain('hunter2');
    expect(body.error).not.toContain('postgres://');
  });

  it('gives every response the same request id, in the body and the header', async () => {
    const res = await handle(request(), 'test.route', async () => ok({}));
    const header = res.headers.get('x-request-id');
    const body = await res.json();
    expect(header).toBeTruthy();
    expect(body.data).toEqual({});
  });

  it('reuses a request id the caller already supplied', async () => {
    const req = new Request('http://localhost/api/test', {
      headers: { 'x-request-id': 'trace-abc-123' },
    });
    const res = await handle(req, 'test.route', async () => ok({}));
    expect(res.headers.get('x-request-id')).toBe('trace-abc-123');
  });

  it('sets the request id on an error response too', async () => {
    const res = await handle(request(), 'test.route', async () => {
      throw new ApiHttpError('NOT_FOUND', 'gone', 404);
    });
    expect(res.headers.get('x-request-id')).toBeTruthy();
    await expect(res.json()).resolves.toMatchObject({ requestId: res.headers.get('x-request-id') });
  });
});

describe('readApiError', () => {
  it('pulls the message, code and details out of an error envelope', async () => {
    const res = err('VALIDATION_ERROR', 'Check the form', 400, {
      fields: { phone: 'Bad number' },
    });
    await expect(readApiError(res)).resolves.toEqual({
      message: 'Check the form',
      code: 'VALIDATION_ERROR',
      details: { fields: { phone: 'Bad number' } },
    });
  });

  it('survives a response that is not JSON at all', async () => {
    const res = new Response('<html>502 Bad Gateway</html>', { status: 502 });
    await expect(readApiError(res)).resolves.toEqual({
      message: 'Request failed (502)',
      code: 'INTERNAL_ERROR',
    });
  });

  it('prefers the server message over a generic one', async () => {
    const res = err('OTP_LOCKED', 'Too many wrong attempts. Try again in 15 minutes.', 429);
    const { message } = await readApiError(res);
    expect(message).toContain('15 minutes');
  });
});
