import { readApiError, type ApiErrorCode } from './api';
import { authorizationHeader } from './sessionHeaders';

/**
 * The browser's half of the customer support contract (§25.9).
 *
 * One ticket is "help me"; the thread is the conversation about it. Everything
 * here is scoped to the caller server-side, so no call takes a customer id.
 */

export class SupportApiError extends Error {
  constructor(
    message: string,
    readonly code: ApiErrorCode | string,
    readonly status: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SupportApiError';
  }

  get fields(): Record<string, string> | null {
    const fields = this.details?.fields;
    return fields && typeof fields === 'object' ? (fields as Record<string, string>) : null;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const auth = await authorizationHeader();

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...auth,
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new SupportApiError(
      'We could not reach SmartHelp. Check your connection and try again.',
      'NETWORK_ERROR',
      0
    );
  }

  if (!res.ok) {
    const { message, code, details } = await readApiError(res);
    throw new SupportApiError(message, code, res.status, details);
  }

  const body = (await res.json()) as { data: T };
  return body.data;
}

export type SupportTicketStatus = 'open' | 'pending' | 'resolved' | 'closed';
export type SupportTicketPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface SupportTicketSummary {
  id: string;
  bookingId: string | null;
  subject: string;
  category: string;
  priority: SupportTicketPriority;
  status: SupportTicketStatus;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupportMessageView {
  id: string;
  authorId: string | null;
  authorName: string | null;
  fromStaff: boolean;
  body: string;
  createdAt: string;
}

export interface SupportTicketDetail {
  ticket: SupportTicketSummary;
  messages: SupportMessageView[];
}

export const SUPPORT_CATEGORIES: { value: string; label: string }[] = [
  { value: 'booking', label: 'A booking' },
  { value: 'payment', label: 'A payment or refund' },
  { value: 'professional', label: 'A professional' },
  { value: 'account', label: 'My account' },
  { value: 'safety', label: 'Safety concern' },
  { value: 'other', label: 'Something else' },
];

export function fetchMyTickets(signal?: AbortSignal): Promise<{
  tickets: SupportTicketSummary[];
  total: number;
}> {
  return request<{ tickets: SupportTicketSummary[]; total: number }>(
    '/api/support/tickets',
    signal ? { signal } : undefined
  );
}

export function fetchMyTicket(id: string, signal?: AbortSignal): Promise<SupportTicketDetail> {
  return request<SupportTicketDetail>(
    `/api/support/tickets/${encodeURIComponent(id)}`,
    signal ? { signal } : undefined
  );
}

export function createTicket(input: {
  subject: string;
  category: string;
  message: string;
  bookingId?: string;
}): Promise<SupportTicketDetail> {
  return request<SupportTicketDetail>('/api/support/tickets', {
    method: 'POST',
    body: JSON.stringify({
      subject: input.subject,
      category: input.category,
      message: input.message,
      ...(input.bookingId ? { bookingId: input.bookingId } : {}),
    }),
  });
}

export function replyToTicket(id: string, body: string): Promise<{ message: SupportMessageView }> {
  return request<{ message: SupportMessageView }>(
    `/api/support/tickets/${encodeURIComponent(id)}/messages`,
    { method: 'POST', body: JSON.stringify({ body }) }
  );
}
