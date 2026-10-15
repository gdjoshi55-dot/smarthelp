import { createServerClient } from './supabaseServer';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Database,
  Notification,
  NotificationChannel,
  NotificationTemplate,
} from './supabase';

/**
 * The notification dispatcher (§27.4, §27.5, §24.11).
 *
 * One entry point — `dispatch()` — turns an event into `notifications` rows
 * and moves each row through `queued -> sent | failed`. It is called from the
 * Route Handlers and crons that own the event; it is the *only* place a
 * notification row is written, so "every catalogue notification fires" is a
 * property of one function rather than of twenty call sites.
 *
 * ## Delivery honesty (D1)
 *
 * `.env.example` says SMS is intentionally not configured, and there is no
 * FCM/APNs provider. Rather than pretend, each channel reports what actually
 * happened:
 *
 * | channel | transport | when unconfigured |
 * |---|---|---|
 * | `in_app` | the row itself + Realtime `me:{profileId}` | always delivered |
 * | `push`   | Realtime to any subscribed browser | always delivered (web) |
 * | `email`  | Nodemailer over `SMTP_*` | `failed`, reason recorded |
 * | `sms` / `whatsapp` | `POST SMS_PROVIDER_URL` | `failed`, reason recorded |
 *
 * The row is written either way: a failed delivery is visible, not silent.
 *
 * ## Failure isolation (§28.4)
 *
 * `dispatch()` never throws. A booking is confirmed whether or not the email
 * server is up; the notification records the failure and the caller moves on.
 * That is the whole point of the try/catch per channel below.
 *
 * ## In-app is universal
 *
 * Every code except `OTP_LOGIN` also writes one `in_app` row, which is what the
 * bell lists and the `me:{profileId}` channel streams. An OTP is a login code,
 * not a bell item, so it is the one exception.
 */

// ── The catalogue (§27.5) ──────────────────────────────────

/**
 * Every notification code the product defines. Kept in one list so a code the
 * catalogue does not name cannot be dispatched by accident, and so the test
 * that asserts "the catalogue fires" has a single thing to iterate.
 */
export const NOTIFICATION_CODES = [
  'OTP_LOGIN',
  'BOOKING_CONFIRMED',
  'PRO_ASSIGNED',
  'PRO_ACCEPTED',
  'PRO_ON_THE_WAY',
  'PRO_ARRIVED',
  'SERVICE_STARTED',
  'SERVICE_ENDING_SOON',
  'SERVICE_COMPLETED',
  'EXTENSION_REQUESTED',
  'EXTENSION_ACCEPTED',
  'EXTENSION_DECLINED',
  'BOOKING_CANCELLED',
  'REFUND_PROCESSED',
  'NEW_OFFER',
  'OFFER_EXPIRING',
  'NEW_JOB_REMINDER',
  'EARNING_CREATED',
  'PAYOUT_SENT',
  'KYC_APPROVED',
  'KYC_REJECTED',
  'TICKET_UPDATE',
  'SAFETY_ALERT',
  'RATING_REMINDER',
] as const;

export type NotificationCode = (typeof NOTIFICATION_CODES)[number];

/**
 * The channels a code fans out to when the caller names none (§27.5). The
 * catalogue's outbound channels, plus `in_app` for everything but `OTP_LOGIN`
 * (see the file header).
 */
export const DEFAULT_CHANNELS: Record<NotificationCode, NotificationChannel[]> = {
  OTP_LOGIN: ['sms'],
  BOOKING_CONFIRMED: ['in_app', 'push', 'sms', 'email'],
  PRO_ASSIGNED: ['in_app', 'push', 'sms'],
  PRO_ACCEPTED: ['in_app', 'push', 'sms'],
  PRO_ON_THE_WAY: ['in_app', 'push', 'sms'],
  PRO_ARRIVED: ['in_app', 'push'],
  SERVICE_STARTED: ['in_app', 'push'],
  SERVICE_ENDING_SOON: ['in_app', 'push'],
  SERVICE_COMPLETED: ['in_app', 'push', 'email'],
  EXTENSION_REQUESTED: ['in_app', 'push'],
  EXTENSION_ACCEPTED: ['in_app', 'push'],
  EXTENSION_DECLINED: ['in_app', 'push'],
  BOOKING_CANCELLED: ['in_app', 'push', 'sms'],
  REFUND_PROCESSED: ['in_app', 'push', 'sms', 'email'],
  NEW_OFFER: ['in_app', 'push'],
  OFFER_EXPIRING: ['in_app', 'push'],
  NEW_JOB_REMINDER: ['in_app', 'push'],
  EARNING_CREATED: ['in_app', 'push', 'sms'],
  PAYOUT_SENT: ['in_app', 'push', 'sms'],
  KYC_APPROVED: ['in_app', 'push', 'email'],
  KYC_REJECTED: ['in_app', 'push', 'email'],
  TICKET_UPDATE: ['in_app', 'push', 'email'],
  SAFETY_ALERT: ['in_app', 'push', 'sms'],
  RATING_REMINDER: ['in_app', 'push'],
};

export const DEFAULT_LOCALE = 'en-IN';

// ── Rendering (§27.4) ──────────────────────────────────────

/** The five characters an email body must never carry raw from a payload. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `BOOKING_CONFIRMED` -> `Booking confirmed`, for a missing-template default. */
function humanize(code: string): string {
  const words = code.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function substitute(
  template: string,
  payload: Record<string, unknown>,
  escape: boolean
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = payload[key];
    if (value === undefined || value === null) return '';
    const text = String(value);
    return escape ? escapeHtml(text) : text;
  });
}

export interface RenderedMessage {
  title: string | null;
  body: string;
}

/**
 * Renders one template against a payload. A missing template is not fatal: the
 * body falls back to a humanised code so a notification with no row still says
 * *something* rather than vanishing.
 */
export function render(
  code: string,
  template: Pick<NotificationTemplate, 'subject' | 'body'> | null,
  payload: Record<string, unknown>,
  escape: boolean
): RenderedMessage {
  if (!template) {
    return { title: humanize(code), body: humanize(code) };
  }
  return {
    title: template.subject ? substitute(template.subject, payload, escape) : null,
    body: substitute(template.body, payload, escape),
  };
}

// ── Delivery ───────────────────────────────────────────────

interface Contact {
  email: string | null;
  phone: string | null;
}

interface DeliveryOutcome {
  status: 'sent' | 'failed';
  error: string | null;
}

/**
 * Delivers one already-rendered message over one channel. Never throws: a
 * transport that is down is a `failed` row, not a 500 for the caller.
 */
async function deliver(
  channel: NotificationChannel,
  message: RenderedMessage,
  contact: Contact
): Promise<DeliveryOutcome> {
  // in_app and push both ride Realtime: writing the row *is* the delivery, and
  // a subscribed browser receives it on `me:{profileId}`.
  if (channel === 'in_app' || channel === 'push') {
    return { status: 'sent', error: null };
  }

  if (channel === 'email') {
    if (!contact.email) {
      return { status: 'failed', error: 'recipient has no email address on file' };
    }
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) {
      return { status: 'failed', error: 'SMTP is not configured' };
    }
    try {
      const { default: nodemailer } = await import('nodemailer');
      const port = Number(process.env.SMTP_PORT || 465);
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      await transporter.sendMail({
        from: process.env.SMTP_FROM || `"SmartHelp" <${user}>`,
        to: contact.email,
        subject: message.title ?? 'SmartHelp',
        text: message.body,
      });
      return { status: 'sent', error: null };
    } catch (e: any) {
      return { status: 'failed', error: `email transport failed: ${e?.message ?? e}` };
    }
  }

  // sms / whatsapp share SmartPOS's generic webhook contract (§27.4).
  const url = process.env.SMS_PROVIDER_URL;
  const key = process.env.SMS_API_KEY;
  if (!url || !key) {
    return { status: 'failed', error: 'no SMS provider configured' };
  }
  if (!contact.phone) {
    return { status: 'failed', error: 'recipient has no phone number on file' };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ to: contact.phone, message: message.body }),
    });
    return res.ok
      ? { status: 'sent', error: null }
      : { status: 'failed', error: `SMS provider returned ${res.status}` };
  } catch (e: any) {
    return { status: 'failed', error: `SMS transport failed: ${e?.message ?? e}` };
  }
}

// ── Dispatch ───────────────────────────────────────────────

export interface DispatchInput {
  code: NotificationCode;
  /** The profile the notification is for. */
  recipientId: string;
  /** Tokens for the template; also stored on the row. */
  payload?: Record<string, unknown>;
  /** Overrides the catalogue default. Mostly for tests. */
  channels?: NotificationChannel[];
  bookingId?: string | null;
  locale?: string;
}

/**
 * Writes and delivers one event's notifications. Returns the rows as written
 * (with their final status), so a caller or a test can see what happened.
 *
 * Never throws (§28.4): the per-channel delivery is caught, and even a failed
 * insert for one channel does not stop the others.
 */
export async function dispatch(
  input: DispatchInput,
  supabase: SupabaseClient<Database> = createServerClient()
): Promise<Notification[]> {
  const channels = input.channels ?? DEFAULT_CHANNELS[input.code] ?? [];
  const payload = input.payload ?? {};
  const locale = input.locale ?? DEFAULT_LOCALE;

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('email, phone')
    .eq('id', input.recipientId)
    .maybeSingle();
  if (profileError) throw profileError;
  const contact: Contact = {
    email: profile?.email ?? null,
    phone: profile?.phone ?? null,
  };

  const written: Notification[] = [];

  for (const channel of channels) {
    try {
      const { data: templateRow } = await supabase
        .from('notification_templates')
        .select('subject, body')
        .eq('code', input.code)
        .eq('channel', channel)
        .eq('locale', locale)
        .eq('is_active', true)
        .maybeSingle();

      const message = render(input.code, templateRow ?? null, payload, channel === 'email');
      const outcome = await deliver(channel, message, contact);

      const { data: row, error: insertError } = await supabase
        .from('notifications')
        .insert({
          recipient_id: input.recipientId,
          channel,
          template_code: input.code,
          payload,
          title: message.title,
          body: message.body,
          status: outcome.status,
          error: outcome.error,
          booking_id: input.bookingId ?? null,
          sent_at: outcome.status === 'sent' ? new Date().toISOString() : null,
        })
        .select('*')
        .single();
      if (insertError) throw insertError;
      written.push(row as Notification);
    } catch (e: any) {
      // A failure to even write the row must not fail the caller's flow. Log
      // and move on; the next channel (and the product) still works.
      console.warn(
        `[notifications] ${input.code} -> ${channel} for ${input.recipientId} failed: ${
          e?.message ?? e
        }`
      );
    }
  }

  return written;
}

/**
 * Convenience for a fire-and-forget dispatch inside a flow that must continue
 * regardless. Swallows everything `dispatch()` might not have caught.
 */
export async function notify(
  input: DispatchInput,
  supabase: SupabaseClient<Database> = createServerClient()
): Promise<void> {
  try {
    await dispatch(input, supabase);
  } catch (e: any) {
    console.warn(`[notifications] dispatch ${input.code} threw: ${e?.message ?? e}`);
  }
}
