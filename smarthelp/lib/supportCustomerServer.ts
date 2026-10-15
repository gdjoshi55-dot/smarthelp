import { ApiHttpError } from './api';
import { createServerClient } from './supabaseServer';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Database,
  SupportMessage,
  SupportTicket,
  SupportTicketPriority,
  SupportTicketStatus,
} from './supabase';

/**
 * The customer's half of the support queue (§24, §25.9).
 *
 * `lib/supportServer.ts` is the staff console: it reads the whole table and its
 * threads. This module is the other side of the same tables — a customer reading
 * *their own* tickets only, with the two rules that make that safe stated once:
 *
 *   1. **Ownership is `raised_by = the caller's profile id`,** applied here and
 *      never taken from the request. The 0037 policies give a customer no select
 *      on `support_tickets` at all (by design — §24 routes it through a handler),
 *      so this is the only gate, and the handler reaches Postgres as the service
 *      role that bypasses RLS.
 *   2. **`is_internal` never leaves.** An internal note is a staff-only message;
 *      the column comment in 0037 says the read model must filter it out before a
 *      ticket is ever shown to the person who raised it, and this is that filter.
 */

type ServerClient = SupabaseClient<Database>;

export interface MyTicketListItem {
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

export interface MyTicketMessage {
  id: string;
  authorId: string | null;
  authorName: string | null;
  /** True when a member of the support team wrote it. */
  fromStaff: boolean;
  body: string;
  createdAt: string;
}

export async function listMyTickets(
  raisedBy: string,
  filters: { limit?: number; offset?: number } = {},
  supabase: ServerClient = createServerClient()
): Promise<{ tickets: MyTicketListItem[]; total: number }> {
  const limit = filters.limit ?? 25;
  const offset = filters.offset ?? 0;

  const { data, error, count } = await supabase
    .from('support_tickets')
    .select('*', { count: 'exact' })
    .eq('raised_by', raisedBy)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  return { tickets: ((data ?? []) as SupportTicket[]).map(project), total: count ?? 0 };
}

/** One owned ticket and its visible thread, or `null` when it is not the caller's. */
export async function getMyTicket(
  id: string,
  raisedBy: string,
  supabase: ServerClient = createServerClient()
): Promise<{ ticket: MyTicketListItem; messages: MyTicketMessage[] } | null> {
  const { data, error } = await supabase
    .from('support_tickets')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const ticket = data as SupportTicket;
  if (ticket.raised_by !== raisedBy) return null;

  const { data: messageRows, error: messagesError } = await supabase
    .from('support_messages')
    .select('*')
    .eq('ticket_id', id)
    .eq('is_internal', false)
    .order('created_at', { ascending: true });
  if (messagesError) throw messagesError;

  const messages = (messageRows ?? []) as SupportMessage[];
  const names = await namesById(
    supabase,
    messages.map((m) => m.author_profile_id)
  );
  const staffIds = await staffProfileIds(
    supabase,
    messages.map((m) => m.author_profile_id)
  );

  return {
    ticket: project(ticket),
    messages: messages.map((m) => ({
      id: m.id,
      authorId: m.author_profile_id,
      authorName: m.author_profile_id ? names[m.author_profile_id] ?? null : null,
      fromStaff: m.author_profile_id ? staffIds.has(m.author_profile_id) : false,
      body: m.body,
      createdAt: m.created_at,
    })),
  };
}

export interface CreateMyTicketInput {
  raisedBy: string;
  subject: string;
  category: string;
  bookingId?: string | null;
  priority?: SupportTicketPriority;
  message: string;
}

/**
 * Open a ticket, with the opening message as its first row.
 *
 * Priority is derived from the category rather than trusted from the browser:
 * a customer may flag something urgent, but "payment" and "safety" are the two
 * the queue sorts up on its own.
 */
export async function createMyTicket(
  input: CreateMyTicketInput,
  supabase: ServerClient = createServerClient()
): Promise<{ ticket: MyTicketListItem; message: MyTicketMessage }> {
  const priority: SupportTicketPriority =
    input.priority ?? (input.category === 'payment' || input.category === 'safety' ? 'high' : 'normal');

  const { data, error } = await supabase
    .from('support_tickets')
    .insert({
      booking_id: input.bookingId ?? null,
      raised_by: input.raisedBy,
      subject: input.subject,
      category: input.category,
      priority,
    })
    .select('*')
    .single();
  if (error) throw error;

  const ticket = data as SupportTicket;

  const { data: messageData, error: messageError } = await supabase
    .from('support_messages')
    .insert({
      ticket_id: ticket.id,
      author_profile_id: input.raisedBy,
      body: input.message,
      is_internal: false,
    })
    .select('*')
    .single();
  if (messageError) throw messageError;

  return {
    ticket: project(ticket),
    message: {
      id: (messageData as SupportMessage).id,
      authorId: input.raisedBy,
      authorName: null,
      fromStaff: false,
      body: input.message,
      createdAt: (messageData as SupportMessage).created_at,
    },
  };
}

/** Append a reply to an owned ticket that is still open. */
export async function addMyTicketMessage(
  id: string,
  raisedBy: string,
  body: string,
  supabase: ServerClient = createServerClient()
): Promise<{ message: MyTicketMessage; assignedTo: string | null }> {
  const { data, error } = await supabase
    .from('support_tickets')
    .select('id, raised_by, status, assigned_to')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.raised_by !== raisedBy) {
    throw new ApiHttpError('NOT_FOUND', 'That support ticket was not found.', 404);
  }
  if (data.status === 'closed') {
    throw new ApiHttpError(
      'INVALID_STATE',
      'This ticket is closed. Open a new one if you still need help.',
      409
    );
  }

  const { data: messageData, error: messageError } = await supabase
    .from('support_messages')
    .insert({ ticket_id: id, author_profile_id: raisedBy, body, is_internal: false })
    .select('*')
    .single();
  if (messageError) throw messageError;

  const message = messageData as SupportMessage;
  return {
    message: {
      id: message.id,
      authorId: raisedBy,
      authorName: null,
      fromStaff: false,
      body: message.body,
      createdAt: message.created_at,
    },
    assignedTo: data.assigned_to,
  };
}

/** The projected ticket both list and detail share. */
function project(ticket: SupportTicket): MyTicketListItem {
  return {
    id: ticket.id,
    bookingId: ticket.booking_id,
    subject: ticket.subject,
    category: ticket.category,
    priority: ticket.priority,
    status: ticket.status,
    resolvedAt: ticket.resolved_at,
    createdAt: ticket.created_at,
    updatedAt: ticket.updated_at,
  };
}

async function namesById(
  supabase: ServerClient,
  ids: (string | null)[]
): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return {};
  const { data, error } = await supabase.from('profiles').select('id, full_name').in('id', unique);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((p) => [p.id, p.full_name]));
}

/** Which of these authors hold a staff role — so the thread can label them. */
async function staffProfileIds(
  supabase: ServerClient,
  ids: (string | null)[]
): Promise<Set<string>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return new Set();
  const { data, error } = await supabase
    .from('profiles')
    .select('id, role')
    .in('id', unique)
    .in('role', ['support', 'ops', 'admin', 'super_admin']);
  if (error) throw error;
  return new Set((data ?? []).map((p) => p.id));
}
