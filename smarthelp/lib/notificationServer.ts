import { createServerClient } from './supabaseServer';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Database,
  Notification,
  NotificationChannel,
  NotificationDevice,
  NotificationTemplate,
} from './supabase';

/**
 * The notification bell, the push-token registry and the template editor
 * (§25.9, §25.10, §24.11).
 *
 * Same shape as the other server modules: service-role reads, the Route Handler
 * gates the caller, and a second query resolves anything PostgREST cannot embed
 * through the hand-maintained `Database` type.
 */

type ServerClient = SupabaseClient<Database>;

export interface NotificationListItem {
  id: string;
  channel: NotificationChannel;
  code: string;
  title: string | null;
  body: string | null;
  status: Notification['status'];
  bookingId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface ListNotificationsOptions {
  /** Defaults to `in_app` — the bell. Pass a channel to widen it. */
  channel?: NotificationChannel;
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * The bell's page. Unread is counted over `in_app` rows, because that is the
 * surface "read" has meaning for; an email nobody opens is not an unread bell
 * item.
 */
export async function listNotifications(
  recipientId: string,
  options: ListNotificationsOptions = {},
  supabase: ServerClient = createServerClient()
): Promise<{ items: NotificationListItem[]; unread: number; total: number }> {
  const limit = options.limit ?? 25;
  const offset = options.offset ?? 0;
  const channel = options.channel ?? 'in_app';

  let query = supabase
    .from('notifications')
    .select('*', { count: 'exact' })
    .eq('recipient_id', recipientId)
    .eq('channel', channel);
  if (options.unreadOnly) query = query.is('read_at', null);

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const { count: unreadCount, error: unreadError } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', recipientId)
    .eq('channel', 'in_app')
    .is('read_at', null);
  if (unreadError) throw unreadError;

  return {
    items: ((data ?? []) as Notification[]).map(toListItem),
    unread: unreadCount ?? 0,
    total: count ?? 0,
  };
}

function toListItem(n: Notification): NotificationListItem {
  return {
    id: n.id,
    channel: n.channel,
    code: n.template_code,
    title: n.title,
    body: n.body,
    status: n.status,
    bookingId: n.booking_id,
    readAt: n.read_at,
    createdAt: n.created_at,
  };
}

/** The badge number alone — cheaper than a page when the bell just needs it. */
export async function unreadCount(
  recipientId: string,
  supabase: ServerClient = createServerClient()
): Promise<number> {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', recipientId)
    .eq('channel', 'in_app')
    .is('read_at', null);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Marks one notification read. Scoped to the recipient so a guessed id cannot
 * read somebody else's row; returns `null` when nothing matched.
 */
export async function markRead(
  id: string,
  recipientId: string,
  supabase: ServerClient = createServerClient()
): Promise<Notification | null> {
  const { data, error } = await supabase
    .from('notifications')
    .update({ status: 'read', read_at: new Date().toISOString() })
    .eq('id', id)
    .eq('recipient_id', recipientId)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return (data as Notification) ?? null;
}

/** Marks every unread in-app row read. Returns how many moved. */
export async function markAllRead(
  recipientId: string,
  supabase: ServerClient = createServerClient()
): Promise<number> {
  const { data, error } = await supabase
    .from('notifications')
    .update({ status: 'read', read_at: new Date().toISOString() })
    .eq('recipient_id', recipientId)
    .eq('channel', 'in_app')
    .is('read_at', null)
    .select('id');
  if (error) throw error;
  return (data ?? []).length;
}

/** Upserts a push token, refreshing `last_seen_at` on a repeat registration. */
export async function registerDevice(
  profileId: string,
  token: string,
  platform: NotificationDevice['platform'] = 'web',
  supabase: ServerClient = createServerClient()
): Promise<NotificationDevice> {
  const { data, error } = await supabase
    .from('notification_devices')
    .upsert(
      { profile_id: profileId, token, platform, last_seen_at: new Date().toISOString() },
      { onConflict: 'profile_id,token' }
    )
    .select('*')
    .single();
  if (error) throw error;
  return data as NotificationDevice;
}

/** Removes a token (e.g. a browser signing out). Scoped to its owner. */
export async function removeDevice(
  profileId: string,
  token: string,
  supabase: ServerClient = createServerClient()
): Promise<void> {
  const { error } = await supabase
    .from('notification_devices')
    .delete()
    .eq('profile_id', profileId)
    .eq('token', token);
  if (error) throw error;
}

// ── Template editor (§25.10) ───────────────────────────────

export interface TemplateFilters {
  code?: string;
  channel?: NotificationChannel;
  locale?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

export async function listTemplates(
  filters: TemplateFilters = {},
  supabase: ServerClient = createServerClient()
): Promise<{ templates: NotificationTemplate[]; total: number }> {
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  let query = supabase.from('notification_templates').select('*', { count: 'exact' });
  if (filters.code) query = query.eq('code', filters.code);
  if (filters.channel) query = query.eq('channel', filters.channel);
  if (filters.locale) query = query.eq('locale', filters.locale);
  if (filters.isActive !== undefined) query = query.eq('is_active', filters.isActive);

  const { data, error, count } = await query
    .order('code', { ascending: true })
    .order('channel', { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return { templates: (data ?? []) as NotificationTemplate[], total: count ?? 0 };
}

export async function getTemplate(
  id: string,
  supabase: ServerClient = createServerClient()
): Promise<NotificationTemplate | null> {
  const { data, error } = await supabase
    .from('notification_templates')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as NotificationTemplate) ?? null;
}

export interface TemplatePatch {
  subject?: string | null;
  body?: string;
  variables?: string[];
  isActive?: boolean;
}

/** Updates a template's copy. `updated_by` is stamped here, not passed. */
export async function updateTemplate(
  id: string,
  patch: TemplatePatch,
  updatedBy: string,
  supabase: ServerClient = createServerClient()
): Promise<NotificationTemplate | null> {
  const row: Database['public']['Tables']['notification_templates']['Update'] = {
    updated_by: updatedBy,
  };
  if (patch.subject !== undefined) row.subject = patch.subject;
  if (patch.body !== undefined) row.body = patch.body;
  if (patch.variables !== undefined) row.variables = patch.variables;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;

  const { data, error } = await supabase
    .from('notification_templates')
    .update(row)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return (data as NotificationTemplate) ?? null;
}
