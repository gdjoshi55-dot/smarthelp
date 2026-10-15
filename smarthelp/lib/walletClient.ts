import { readApiError, type ApiErrorCode } from './api';
import { authorizationHeader } from './sessionHeaders';

/**
 * The browser's half of the wallet and refund read model (§12.4, §25.4).
 *
 * Two calls, one screen: `GET /api/wallet` is the credit ledger (refund-to-wallet
 * credits plus any debit) and `GET /api/refunds` is what produced those credits.
 * Both are scoped server-side to the caller's own `customers.id`, so neither
 * takes an id from the client.
 */

export class WalletApiError extends Error {
  constructor(
    message: string,
    readonly code: ApiErrorCode | string,
    readonly status: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'WalletApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const auth = await authorizationHeader();

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      credentials: 'include',
      headers: { accept: 'application/json', ...auth, ...(init?.headers ?? {}) },
    });
  } catch {
    throw new WalletApiError(
      'We could not reach SmartHelp. Check your connection and try again.',
      'NETWORK_ERROR',
      0
    );
  }

  if (!res.ok) {
    const { message, code, details } = await readApiError(res);
    throw new WalletApiError(message, code, res.status, details);
  }

  const body = (await res.json()) as { data: T };
  return body.data;
}

export interface WalletTransaction {
  id: string;
  type: 'credit' | 'debit';
  amount: number;
  balanceAfter: number;
  refType: string;
  refId: string | null;
  description: string;
  createdAt: string;
}

export interface WalletResult {
  balance: number;
  transactions: WalletTransaction[];
  total: number;
  limit: number;
  offset: number;
}

export interface RefundRow {
  id: string;
  paymentId: string;
  bookingId: string | null;
  amount: number;
  currency: string;
  status: string;
  route: string | null;
  reasonCode: string | null;
  note: string | null;
  requestedAt: string;
  completedAt: string | null;
}

/** The caller's own wallet balance and ledger. */
export function fetchWallet(signal?: AbortSignal): Promise<WalletResult> {
  return request<WalletResult>('/api/wallet', signal ? { signal } : undefined);
}

/** The caller's own refunds — the events that credit the wallet. */
export function fetchRefunds(signal?: AbortSignal): Promise<{ refunds: RefundRow[] }> {
  return request<{ refunds: RefundRow[] }>('/api/refunds', signal ? { signal } : undefined);
}
