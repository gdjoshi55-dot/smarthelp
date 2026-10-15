import { createServerClient } from './supabaseServer';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChatMessage, ChatMessageKind, ChatThread, Database } from './supabase';

/**
 * The booking chat (§24.11, §27.1 `chat:{threadId}`).
 *
 * A thread is one-per-booking and created lazily: it cannot exist before a
 * professional is assigned, because a thread's two participants are the
 * booking's customer and its professional. The Route Handler decides who may
 * call what; this module decides nothing about authority beyond refusing to
 * invent a participant.
 */

type ServerClient = SupabaseClient<Database>;

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

async function profileForCustomer(
  supabase: ServerClient,
  customerId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('customers')
    .select('profile_id')
    .eq('id', customerId)
    .maybeSingle();
  if (error) throw error;
  return data?.profile_id ?? null;
}

async function profileForProfessional(
  supabase: ServerClient,
  professionalId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('professionals')
    .select('profile_id')
    .eq('id', professionalId)
    .maybeSingle();
  if (error) throw error;
  return data?.profile_id ?? null;
}

async function toThreadView(
  supabase: ServerClient,
  thread: ChatThread
): Promise<ChatThreadView | null> {
  const [customerProfileId, professionalProfileId, booking] = await Promise.all([
    profileForCustomer(supabase, thread.customer_id),
    profileForProfessional(supabase, thread.professional_id),
    supabase.from('bookings').select('booking_number').eq('id', thread.booking_id).maybeSingle(),
  ]);
  // A thread whose participants cannot be resolved is not a thread we serve.
  if (!customerProfileId || !professionalProfileId) return null;

  return {
    id: thread.id,
    bookingId: thread.booking_id,
    bookingNumber: booking.data?.booking_number ?? null,
    customerProfileId,
    professionalProfileId,
    lastMessageAt: thread.last_message_at,
    closedAt: thread.closed_at,
    createdAt: thread.created_at,
  };
}

/**
 * A booking's chat participants, resolved but **not created**. The Route
 * Handler authorises against this before it lets a thread come into being, so a
 * thread only ever exists for a booking that has one.
 */
export interface BookingChatContext {
  bookingId: string;
  bookingNumber: string | null;
  customerProfileId: string;
  professionalProfileId: string | null;
}

export async function getBookingChatContext(
  bookingId: string,
  supabase: ServerClient = createServerClient()
): Promise<BookingChatContext | null> {
  const { data: booking, error } = await supabase
    .from('bookings')
    .select('id, booking_number, customer_id, professional_id')
    .eq('id', bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!booking) return null;

  const [customerProfileId, professionalProfileId] = await Promise.all([
    profileForCustomer(supabase, booking.customer_id),
    booking.professional_id
      ? profileForProfessional(supabase, booking.professional_id)
      : Promise.resolve(null),
  ]);
  if (!customerProfileId) return null;

  return {
    bookingId: booking.id,
    bookingNumber: booking.booking_number ?? null,
    customerProfileId,
    professionalProfileId,
  };
}

/**
 * Returns the booking's thread, creating it if the booking is assigned. `null`
 * when the booking does not exist or has no professional yet — in both cases
 * there is no chat to show and no thread to invent.
 */
export async function getOrCreateThreadForBooking(
  bookingId: string,
  supabase: ServerClient = createServerClient()
): Promise<ChatThreadView | null> {
  const { data: booking, error: bookingError } = await supabase
    .from('bookings')
    .select('id, customer_id, professional_id')
    .eq('id', bookingId)
    .maybeSingle();
  if (bookingError) throw bookingError;
  if (!booking || !booking.professional_id) return null;

  const { data: thread, error: threadError } = await supabase
    .from('chat_threads')
    .upsert(
      {
        booking_id: booking.id,
        customer_id: booking.customer_id,
        professional_id: booking.professional_id,
      },
      { onConflict: 'booking_id' }
    )
    .select('*')
    .single();
  if (threadError) throw threadError;

  return toThreadView(supabase, thread as ChatThread);
}

/** One thread by id, or `null`. */
export async function getThreadView(
  threadId: string,
  supabase: ServerClient = createServerClient()
): Promise<ChatThreadView | null> {
  const { data, error } = await supabase
    .from('chat_threads')
    .select('*')
    .eq('id', threadId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return toThreadView(supabase, data as ChatThread);
}

/** The thread's history, oldest first. */
export async function listMessages(
  threadId: string,
  options: { limit?: number } = {},
  supabase: ServerClient = createServerClient()
): Promise<ChatMessageView[]> {
  const limit = options.limit ?? 200;
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;

  const rows = (data ?? []) as ChatMessage[];
  if (rows.length === 0) return [];

  const senderIds = [...new Set(rows.map((r) => r.sender_id).filter((v): v is string => !!v))];
  const names: Record<string, string> = {};
  if (senderIds.length > 0) {
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in('id', senderIds);
    if (profilesError) throw profilesError;
    for (const p of profiles ?? []) names[p.id] = p.full_name;
  }

  return rows.map((m) => ({
    id: m.id,
    threadId: m.thread_id,
    senderId: m.sender_id,
    senderName: m.sender_id ? names[m.sender_id] ?? null : null,
    kind: m.kind,
    body: m.body,
    imagePath: m.image_path,
    readAt: m.read_at,
    createdAt: m.created_at,
  }));
}

export interface PostMessageInput {
  senderId: string | null;
  kind?: ChatMessageKind;
  body?: string | null;
  imagePath?: string | null;
}

/**
 * Appends a message and moves the thread's `last_message_at` in the same call,
 * so the inbox ordering and the message can never disagree. A system message is
 * server-written (`senderId: null`).
 */
export async function postMessage(
  threadId: string,
  input: PostMessageInput,
  supabase: ServerClient = createServerClient()
): Promise<ChatMessageView> {
  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      thread_id: threadId,
      sender_id: input.senderId,
      kind: input.kind ?? 'text',
      body: input.body ?? null,
      image_path: input.imagePath ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;

  const message = data as ChatMessage;
  const { error: touchError } = await supabase
    .from('chat_threads')
    .update({ last_message_at: message.created_at })
    .eq('id', threadId);
  if (touchError) throw touchError;

  let senderName: string | null = null;
  if (message.sender_id) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', message.sender_id)
      .maybeSingle();
    senderName = profile?.full_name ?? null;
  }

  return {
    id: message.id,
    threadId: message.thread_id,
    senderId: message.sender_id,
    senderName,
    kind: message.kind,
    body: message.body,
    imagePath: message.image_path,
    readAt: message.read_at,
    createdAt: message.created_at,
  };
}
