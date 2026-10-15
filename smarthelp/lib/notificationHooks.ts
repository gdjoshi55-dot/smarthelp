import { createServerClient } from './supabaseServer';
import { notify } from './notifications';
import type { Database } from './supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The bridge between a booking event and the notification catalogue (§27.5).
 *
 * Each route that moves a booking calls exactly one function here, right after
 * the write it already makes. The functions are deliberately *quiet*: every
 * query and every dispatch is wrapped, so a notification that cannot be sent
 * (or even composed) can never change the outcome of the action that fired it —
 * §28.4 failure isolation, and the reason a booking still confirms when the
 * mail server is down.
 *
 * All of them take the ids the route already holds; none of them re-authorise
 * or write domain state.
 */

type ServerClient = SupabaseClient<Database>;

const DATE_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const TIME_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: 'numeric',
  minute: '2-digit',
});

function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  try {
    return DATE_FMT.format(new Date(value));
  } catch {
    return '';
  }
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '';
  try {
    return TIME_FMT.format(new Date(value));
  } catch {
    return '';
  }
}

interface BookingContext {
  bookingId: string;
  bookingNumber: string | null;
  customerProfileId: string | null;
  professionalProfileId: string | null;
  serviceName: string;
  customerName: string;
  proName: string;
  date: string;
  time: string;
  arrivalTime: string;
  amount: string;
  startsAt: string | null;
  endsAt: string | null;
}

async function serviceNameFor(
  supabase: ServerClient,
  bookingId: string
): Promise<string> {
  const { data: items } = await supabase
    .from('booking_items')
    .select('service_id')
    .eq('booking_id', bookingId)
    .limit(1);
  const serviceId = items?.[0]?.service_id;
  if (!serviceId) return 'your service';
  const { data: service } = await supabase
    .from('services')
    .select('name')
    .eq('id', serviceId)
    .maybeSingle();
  return service?.name ?? 'your service';
}

async function customerProfileId(
  supabase: ServerClient,
  customerId: string | null
): Promise<string | null> {
  if (!customerId) return null;
  const { data } = await supabase
    .from('customers')
    .select('profile_id')
    .eq('id', customerId)
    .maybeSingle();
  return data?.profile_id ?? null;
}

async function professionalProfileId(
  supabase: ServerClient,
  professionalId: string | null
): Promise<string | null> {
  if (!professionalId) return null;
  const { data } = await supabase
    .from('professionals')
    .select('profile_id')
    .eq('id', professionalId)
    .maybeSingle();
  return data?.profile_id ?? null;
}

async function profileName(supabase: ServerClient, profileId: string | null): Promise<string> {
  if (!profileId) return '';
  const { data } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', profileId)
    .maybeSingle();
  return data?.full_name ?? '';
}

/** Everything an event's template tokens need, gathered once. */
async function bookingContext(
  bookingId: string,
  supabase: ServerClient
): Promise<BookingContext | null> {
  const { data: booking } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .maybeSingle();
  if (!booking) return null;

  const row = booking as Record<string, any>;
  const [customerPid, proPid, serviceName] = await Promise.all([
    customerProfileId(supabase, row.customer_id ?? null),
    professionalProfileId(supabase, row.professional_id ?? null),
    serviceNameFor(supabase, bookingId),
  ]);
  const [customerName, proName] = await Promise.all([
    profileName(supabase, customerPid),
    profileName(supabase, proPid),
  ]);

  const scheduled = row.scheduled_start_at ?? null;
  return {
    bookingId,
    bookingNumber: row.booking_number ?? null,
    customerProfileId: customerPid,
    professionalProfileId: proPid,
    serviceName,
    customerName,
    proName,
    date: formatDate(scheduled),
    time: formatTime(scheduled),
    arrivalTime: formatTime(row.started_at ?? scheduled),
    amount: row.total_amount != null ? `₹${row.total_amount}` : '',
    startsAt: scheduled,
    endsAt: row.ends_at ?? null,
  };
}

function tokens(ctx: BookingContext): Record<string, unknown> {
  return {
    bookingId: ctx.bookingNumber ?? ctx.bookingId,
    bookingNumber: ctx.bookingNumber,
    serviceName: ctx.serviceName,
    customerName: ctx.customerName,
    proName: ctx.proName,
    date: ctx.date,
    time: ctx.time,
    arrivalTime: ctx.arrivalTime,
    amount: ctx.amount,
  };
}

/** Runs `fn`, swallowing everything — a hook must never break its caller. */
async function quiet(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e: any) {
    console.warn(`[notification-hooks] ${e?.message ?? e}`);
  }
}

// ── The hooks ──────────────────────────────────────────────

export function notifyBookingConfirmed(bookingId: string): Promise<void> {
  return quiet(async () => {
    const supabase = createServerClient();
    const ctx = await bookingContext(bookingId, supabase);
    if (!ctx?.customerProfileId) return;
    await notify(
      { code: 'BOOKING_CONFIRMED', recipientId: ctx.customerProfileId, payload: tokens(ctx), bookingId },
      supabase
    );
  });
}

/** The customer hears their professional accepted. */
export function notifyOfferAccepted(bookingId: string): Promise<void> {
  return quiet(async () => {
    const supabase = createServerClient();
    const ctx = await bookingContext(bookingId, supabase);
    if (!ctx?.customerProfileId) return;
    await notify(
      { code: 'PRO_ACCEPTED', recipientId: ctx.customerProfileId, payload: tokens(ctx), bookingId },
      supabase
    );
  });
}

/** An admin manual assign is the other half of "assignment outcome". */
export function notifyProAssigned(bookingId: string): Promise<void> {
  return quiet(async () => {
    const supabase = createServerClient();
    const ctx = await bookingContext(bookingId, supabase);
    if (!ctx?.customerProfileId) return;
    await notify(
      { code: 'PRO_ASSIGNED', recipientId: ctx.customerProfileId, payload: tokens(ctx), bookingId },
      supabase
    );
  });
}

export function notifyProOnTheWay(bookingId: string): Promise<void> {
  return quiet(async () => {
    const supabase = createServerClient();
    const ctx = await bookingContext(bookingId, supabase);
    if (!ctx?.customerProfileId) return;
    await notify(
      {
        code: 'PRO_ON_THE_WAY',
        recipientId: ctx.customerProfileId,
        payload: { ...tokens(ctx), etaMinutes: '' },
        bookingId,
      },
      supabase
    );
  });
}

export function notifyProArrived(bookingId: string): Promise<void> {
  return quiet(async () => {
    const supabase = createServerClient();
    const ctx = await bookingContext(bookingId, supabase);
    if (!ctx?.customerProfileId) return;
    await notify(
      { code: 'PRO_ARRIVED', recipientId: ctx.customerProfileId, payload: tokens(ctx), bookingId },
      supabase
    );
  });
}

export function notifyServiceStarted(bookingId: string): Promise<void> {
  return quiet(async () => {
    const supabase = createServerClient();
    const ctx = await bookingContext(bookingId, supabase);
    if (!ctx?.customerProfileId) return;
    await notify(
      {
        code: 'SERVICE_STARTED',
        recipientId: ctx.customerProfileId,
        payload: { ...tokens(ctx), endsAt: formatTime(ctx.endsAt) },
        bookingId,
      },
      supabase
    );
  });
}

/** Completion notifies the customer, and the professional their earning. */
export function notifyServiceCompleted(bookingId: string): Promise<void> {
  return quiet(async () => {
    const supabase = createServerClient();
    const ctx = await bookingContext(bookingId, supabase);
    if (ctx?.customerProfileId) {
      await notify(
        { code: 'SERVICE_COMPLETED', recipientId: ctx.customerProfileId, payload: tokens(ctx), bookingId },
        supabase
      );
    }
    if (ctx?.professionalProfileId) {
      await notify(
        { code: 'EARNING_CREATED', recipientId: ctx.professionalProfileId, payload: tokens(ctx), bookingId },
        supabase
      );
    }
  });
}

/** Cancellation reaches whoever is left watching. */
export function notifyBookingCancelled(bookingId: string, reason = ''): Promise<void> {
  return quiet(async () => {
    const supabase = createServerClient();
    const ctx = await bookingContext(bookingId, supabase);
    if (!ctx) return;
    const payload = { ...tokens(ctx), reason };
    if (ctx.customerProfileId) {
      await notify(
        { code: 'BOOKING_CANCELLED', recipientId: ctx.customerProfileId, payload, bookingId },
        supabase
      );
    }
    if (ctx.professionalProfileId) {
      await notify(
        { code: 'BOOKING_CANCELLED', recipientId: ctx.professionalProfileId, payload, bookingId },
        supabase
      );
    }
  });
}

export function notifyRefundProcessed(
  bookingId: string,
  amount: string,
  destination: string
): Promise<void> {
  return quiet(async () => {
    const supabase = createServerClient();
    const ctx = await bookingContext(bookingId, supabase);
    if (!ctx?.customerProfileId) return;
    await notify(
      {
        code: 'REFUND_PROCESSED',
        recipientId: ctx.customerProfileId,
        payload: { ...tokens(ctx), amount, destination },
        bookingId,
      },
      supabase
    );
  });
}

/** The offer inbox's own event — one professional, one fan-out. */
export function notifyNewOffer(
  professionalId: string,
  bookingId: string,
  payout = ''
): Promise<void> {
  return quiet(async () => {
    const supabase = createServerClient();
    const ctx = await bookingContext(bookingId, supabase);
    if (!ctx) return;
    const proPid = await professionalProfileId(supabase, professionalId);
    if (!proPid) return;
    await notify(
      {
        code: 'NEW_OFFER',
        recipientId: proPid,
        payload: { ...tokens(ctx), payout, locality: '' },
        bookingId,
      },
      supabase
    );
  });
}

export function notifyKycDecision(
  professionalId: string,
  approved: boolean,
  reason = ''
): Promise<void> {
  return quiet(async () => {
    const supabase = createServerClient();
    const proPid = await professionalProfileId(supabase, professionalId);
    if (!proPid) return;
    const proName = await profileName(supabase, proPid);
    await notify(
      {
        code: approved ? 'KYC_APPROVED' : 'KYC_REJECTED',
        recipientId: proPid,
        payload: { proName, reason },
      },
      supabase
    );
  });
}

export function notifyTicketUpdate(ticketId: string, recipientProfileId: string | null): Promise<void> {
  return quiet(async () => {
    if (!recipientProfileId) return;
    const supabase = createServerClient();
    const { data: ticket } = await supabase
      .from('support_tickets')
      .select('subject')
      .eq('id', ticketId)
      .maybeSingle();
    await notify(
      {
        code: 'TICKET_UPDATE',
        recipientId: recipientProfileId,
        payload: { ticketSubject: ticket?.subject ?? 'your ticket' },
      },
      supabase
    );
  });
}
