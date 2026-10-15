import { readApiError, type ApiErrorCode } from './api';
import { authorizationHeader } from './sessionHeaders';
import type { NotificationChannel, NotificationStatus } from './supabase';

/**
 * The browser's half of the notification contract (§25.9, §25.10, §27).
 *
 * Same transport decisions as the other client modules: the session lives in
 * `localStorage`, `requireAuth` reads only the `Authorization` header, and a
 * fetch that forgets it is a 401 that reads as "Please sign in" on a page the
 * user is visibly signed in to.
 */

export class NotificationApiError extends Error {
  constructor(
    message: string,
    readonly code: ApiErrorCode | string,
    readonly status: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'NotificationApiError';
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
    throw new NotificationApiError(
      'We could not reach SmartHelp. Check your connection and try again.',
      'NETWORK_ERROR',
      0
    );
  }

  if (!res.ok) {
    const { message, code, details } = await readApiError(res);
    throw new NotificationApiError(message, code, res.status, details);
  }

  const body = (await res.json()) as { data: T };
  return body.data;
}

// ── The bell (§25.9) ─────────────────────────────────────────

/** One row of the bell, as `notificationServer.listNotifications` returns it. */
export interface NotificationListItem {
  id: string;
  channel: NotificationChannel;
  code: string;
  title: string | null;
  body: string | null;
  status: NotificationStatus;
  bookingId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  items: NotificationListItem[];
  unread: number;
  total: number;
}

export interface NotificationQuery {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}

export function fetchNotifications(query: NotificationQuery = {}): Promise<NotificationPage> {
  const params = new URLSearchParams();
  if (query.unreadOnly) params.set('unreadOnly', 'true');
  if (query.limit != null) params.set('limit', String(query.limit));
  if (query.offset != null) params.set('offset', String(query.offset));
  const qs = params.toString();
  return request<NotificationPage>(`/api/notifications${qs ? `?${qs}` : ''}`);
}

export function markNotificationRead(id: string): Promise<{ id: string; status: string; readAt: string | null }> {
  return request(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
}

export function markAllNotificationsRead(): Promise<{ marked: number }> {
  return request('/api/notifications/read-all', { method: 'POST' });
}

export function registerPushToken(
  token: string,
  platform: 'web' | 'ios' | 'android' = 'web'
): Promise<{ device: Record<string, unknown> }> {
  return request('/api/notifications/push-token', {
    method: 'POST',
    body: JSON.stringify({ token, platform }),
  });
}

export function unregisterPushToken(token: string): Promise<{ removed: true }> {
  return request('/api/notifications/push-token', {
    method: 'DELETE',
    body: JSON.stringify({ token }),
  });
}

// ── Template editor (§25.10) ─────────────────────────────────

export interface NotificationTemplateRow {
  id: string;
  code: string;
  channel: NotificationChannel;
  locale: string;
  subject: string | null;
  body: string;
  variables: string[];
  is_active: boolean;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TemplateQuery {
  code?: string;
  channel?: NotificationChannel;
  locale?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

export function fetchNotificationTemplates(
  query: TemplateQuery = {}
): Promise<{ templates: NotificationTemplateRow[]; total: number }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return request(`/api/admin/notification-templates${qs ? `?${qs}` : ''}`);
}

export interface TemplatePatch {
  subject?: string | null;
  body?: string;
  variables?: string[];
  isActive?: boolean;
}

export function updateNotificationTemplate(
  id: string,
  patch: TemplatePatch
): Promise<{ template: NotificationTemplateRow }> {
  return request(`/api/admin/notification-templates/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}
