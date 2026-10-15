import { readApiError, type ApiErrorCode } from './api';
import { authorizationHeader } from './sessionHeaders';
import type { ChatMessageKind } from './supabase';

/**
 * The browser's half of the booking chat (§25.9, §24.11, §27.1).
 *
 * The thread view and message view mirror `lib/chatServer.ts` exactly, but are
 * declared here rather than imported: `chatServer` pulls `supabaseServer`, and a
 * client component that imported it would drag the service-role client into the
 * browser bundle. The two shapes are asserted equal by the route tests, not by a
 * shared import.
 */

export class ChatApiError extends Error {
  constructor(
    message: string,
    readonly code: ApiErrorCode | string,
    readonly status: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ChatApiError';
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
    throw new ChatApiError(
      'We could not reach SmartHelp. Check your connection and try again.',
      'NETWORK_ERROR',
      0
    );
  }

  if (!res.ok) {
    const { message, code, details } = await readApiError(res);
    throw new ChatApiError(message, code, res.status, details);
  }

  const body = (await res.json()) as { data: T };
  return body.data;
}

export interface ChatThreadView {
  id: string;
  bookingId: string;
  bookingNumber: string | null;
  customerProfileId: string;
  professionalProfileId: string;
  lastMessageAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface ChatMessageView {
  id: string;
  threadId: string;
  senderId: string | null;
  senderName: string | null;
  kind: ChatMessageKind;
  body: string | null;
  imagePath: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface ChatView {
  thread: ChatThreadView;
  messages: ChatMessageView[];
  canPost: boolean;
}

/** A booking's thread + history, created lazily server-side (`GET /api/bookings/:id/chat`). */
export function fetchBookingChat(bookingId: string): Promise<ChatView> {
  return request<ChatView>(`/api/bookings/${encodeURIComponent(bookingId)}/chat`);
}

/** A thread's history by thread id (`GET /api/chat/threads/:id/messages`). */
export function fetchThreadMessages(threadId: string): Promise<ChatView> {
  return request<ChatView>(`/api/chat/threads/${encodeURIComponent(threadId)}/messages`);
}

export interface SendMessageInput {
  kind?: 'text' | 'image';
  body?: string;
  imagePath?: string;
}

/** Send a message (`POST /api/chat/threads/:id/messages`). System messages are server-only. */
export function sendMessage(
  threadId: string,
  input: SendMessageInput
): Promise<{ message: ChatMessageView }> {
  return request(`/api/chat/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ kind: input.kind ?? 'text', body: input.body, imagePath: input.imagePath }),
  });
}
