import { NextResponse } from 'next/server';

/**
 * The response envelope and the error catalogue (§25.1, §25.2).
 *
 * Every Route Handler answers in this shape. The client reads `code` to decide
 * what to do and `error` to say — the message is written to be shown to a
 * human, so it is never "Something went wrong" when the server knows better.
 */

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'STALE_VERSION'
  | 'ASSIGNMENT_TAKEN'
  | 'PRICE_CHANGED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_NOT_VERIFIED'
  | 'SERVICE_UNAVAILABLE'
  | 'NO_SLOT_AVAILABLE'
  | 'PROFESSIONAL_UNAVAILABLE'
  | 'OTP_INVALID'
  | 'OTP_EXPIRED'
  | 'OTP_LOCKED'
  | 'RATE_LIMITED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ILLEGAL_TRANSITION'
  | 'ADDRESS_IN_USE'
  | 'ACCOUNT_EXISTS'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  STALE_VERSION: 409,
  ASSIGNMENT_TAKEN: 409,
  PRICE_CHANGED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  ILLEGAL_TRANSITION: 409,
  ADDRESS_IN_USE: 409,
  ACCOUNT_EXISTS: 409,
  PAYMENT_FAILED: 402,
  PAYMENT_NOT_VERIFIED: 402,
  SERVICE_UNAVAILABLE: 422,
  NO_SLOT_AVAILABLE: 422,
  PROFESSIONAL_UNAVAILABLE: 422,
  OTP_INVALID: 422,
  OTP_EXPIRED: 422,
  OTP_LOCKED: 429,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export interface ApiErrorBody {
  success: false;
  error: string;
  code: ApiErrorCode;
  details?: Record<string, unknown>;
  requestId: string;
  timestamp: string;
}

export function ok<T>(data: T, status = 200, headers?: HeadersInit): NextResponse {
  return NextResponse.json({ success: true as const, data }, { status, headers });
}

export function created<T>(data: T, headers?: HeadersInit): NextResponse {
  return ok(data, 201, headers);
}

export function noContent(headers?: HeadersInit): NextResponse {
  return new NextResponse(null, { status: 204, headers });
}

export function err(
  code: ApiErrorCode,
  message: string,
  statusOverride?: number,
  details?: Record<string, unknown>
): NextResponse<ApiErrorBody> {
  return NextResponse.json(
    {
      success: false as const,
      error: message,
      code,
      ...(details ? { details } : {}),
      requestId: 'server',
      timestamp: new Date().toISOString(),
    },
    { status: statusOverride ?? STATUS_BY_CODE[code] ?? 500 }
  );
}

/** Field-level validation failure. `details.fields` is keyed by field name. */
export function validationError(
  message: string,
  fields?: Record<string, string>,
  status = 400
): NextResponse<ApiErrorBody> {
  return err('VALIDATION_ERROR', message, status, fields ? { fields } : undefined);
}

/**
 * An error a route can throw instead of returning, so that `requireAuth()` and
 * the validators can be used mid-flow without every call site branching.
 */
export class ApiHttpError extends Error {
  code: ApiErrorCode;
  status: number;
  details?: Record<string, unknown>;

  constructor(
    code: ApiErrorCode,
    message: string,
    status?: number,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiHttpError';
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code] ?? 500;
    this.details = details;
  }
}

/**
 * Wraps a handler so that an unexpected throw becomes a clean INTERNAL_ERROR
 * instead of an HTML 500 page, and the request id reaches the log.
 */
export async function handle(
  req: Request,
  name: string,
  fn: (requestId: string) => Promise<NextResponse>
): Promise<NextResponse> {
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  try {
    const res = await fn(requestId);
    res.headers.set('x-request-id', requestId);
    return res;
  } catch (e: any) {
    if (e instanceof ApiHttpError) {
      return NextResponse.json(
        {
          success: false as const,
          error: e.message,
          code: e.code,
          ...(e.details ? { details: e.details } : {}),
          requestId,
          timestamp: new Date().toISOString(),
        },
        { status: e.status, headers: { 'x-request-id': requestId } }
      );
    }
    // Never log a token, an OTP, a password or a payment secret.
    console.error(`[${requestId}] ${name} failed:`, e?.message ?? e);
    const body: ApiErrorBody = {
      success: false,
      error: 'Something went wrong on our side. Please try again.',
      code: 'INTERNAL_ERROR',
      requestId,
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(body, { status: 500, headers: { 'x-request-id': requestId } });
  }
}

/** Client-side helper: pull `{ error, code, details }` out of any API response. */
export async function readApiError(res: Response): Promise<{
  message: string;
  code: ApiErrorCode | string;
  details?: Record<string, any>;
}> {
  try {
    const body = await res.json();
    return {
      message: body?.error || 'Request failed',
      code: body?.code || 'INTERNAL_ERROR',
      details: body?.details,
    };
  } catch {
    return { message: `Request failed (${res.status})`, code: 'INTERNAL_ERROR' };
  }
}
