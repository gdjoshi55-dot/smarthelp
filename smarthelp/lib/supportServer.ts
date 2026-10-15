import { createServerClient } from './supabaseServer';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Database,
  Dispute,
  DisputeStatus,
  SupportMessage,
  SupportTicket,
  SupportTicketPriority,
  SupportTicketStatus,
} from './supabase';

/**
 * The support and dispute consoles (§24, §25.10, §31.1).
 *
 * Same shape as the rest of the admin server modules: service-role reads, no
 * RLS re-check (the Route Handler gates the caller), and names resolved with a
 * second query rather than a PostgREST embed, because the hand-maintained
 * `Database` type carries no foreign-key relationships to embed through.
 *
 * A ticket and a dispute are kept apart on purpose: a ticket is "help me", a
 * dispute is "this outcome is wrong and I want it adjudicated". They share the
 * queue only at the screen.
 */

type ServerClient = SupabaseClient<Database>;

export interface AdminSupportTicketListItem {
  id: string;
  bookingId: string | null;
  bookingNumber: string | null;
  subject: string;
  category: string;
  priority: SupportTicketPriority;
  status: SupportTicketStatus;
  assignedToId: string | null;
  assignedToName: string | null;
  raisedById: string | null;
  raisedByName: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSupportTicketFilters {
  status?: SupportTicketStatus;
  priority?: SupportTicketPriority;
  assignedTo?: string;
  /** Subject substring. */
  q?: string;
  limit?: number;
  offset?: number;
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

async function bookingNumbers(
  supabase: ServerClient,
  ids: (string | null)[]
): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return {};
  const { data, error } = await supabase
    .from('bookings')
    .select('id, booking_number')
    .in('id', unique);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((b) => [b.id, b.booking_number]));
}

/**
 * The support queue. Staff read it; filters are applied before the service-role
 * query runs and the names are attached after, so one ticket never costs more
 * than a fixed number of queries.
 */
export async function listSupportTickets(
  filters: AdminSupportTicketFilters = {},
  supabase: ServerClient = createServerClient()
): Promise<{ tickets: AdminSupportTicketListItem[]; total: number }> {
  const limit = filters.limit ?? 25;
  const offset = filters.offset ?? 0;

  let query = supabase.from('support_tickets').select('*', { count: 'exact' });
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.priority) query = query.eq('priority', filters.priority);
  if (filters.assignedTo) query = query.eq('assigned_to', filters.assignedTo);
  if (filters.q) query = query.ilike('subject', `%${filters.q}%`);

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const rows = (data ?? []) as SupportTicket[];
  if (rows.length === 0) return { tickets: [], total: count ?? 0 };

  const [profiles, bookings] = await Promise.all([
    namesById(supabase, rows.flatMap((r) => [r.assigned_to, r.raised_by])),
    bookingNumbers(supabase, rows.map((r) => r.booking_id)),
  ]);

  return {
    tickets: rows.map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      bookingNumber: r.booking_id ? bookings[r.booking_id] ?? null : null,
      subject: r.subject,
      category: r.category,
      priority: r.priority,
      status: r.status,
      assignedToId: r.assigned_to,
      assignedToName: r.assigned_to ? profiles[r.assigned_to] ?? null : null,
      raisedById: r.raised_by,
      raisedByName: r.raised_by ? profiles[r.raised_by] ?? null : null,
      resolution: r.resolution,
      resolvedAt: r.resolved_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    total: count ?? rows.length,
  };
}

export interface AdminSupportMessage {
  id: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  isInternal: boolean;
  createdAt: string;
}

export interface AdminSupportTicketDetail {
  ticket: AdminSupportTicketListItem;
  messages: AdminSupportMessage[];
}

/** One ticket and its thread. `null` when the id matches nothing. */
export async function getSupportTicket(
  id: string,
  supabase: ServerClient = createServerClient()
): Promise<AdminSupportTicketDetail | null> {
  const { data, error } = await supabase
    .from('support_tickets')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const ticket = data as SupportTicket;

  const { data: messageRows, error: messagesError } = await supabase
    .from('support_messages')
    .select('*')
    .eq('ticket_id', id)
    .order('created_at', { ascending: true });
  if (messagesError) throw messagesError;

  const messages = (messageRows ?? []) as SupportMessage[];
  const [profiles, bookings] = await Promise.all([
    namesById(supabase, [ticket.assigned_to, ticket.raised_by, ...messages.map((m) => m.author_profile_id)]),
    bookingNumbers(supabase, [ticket.booking_id]),
  ]);

  return {
    ticket: {
      id: ticket.id,
      bookingId: ticket.booking_id,
      bookingNumber: ticket.booking_id ? bookings[ticket.booking_id] ?? null : null,
      subject: ticket.subject,
      category: ticket.category,
      priority: ticket.priority,
      status: ticket.status,
      assignedToId: ticket.assigned_to,
      assignedToName: ticket.assigned_to ? profiles[ticket.assigned_to] ?? null : null,
      raisedById: ticket.raised_by,
      raisedByName: ticket.raised_by ? profiles[ticket.raised_by] ?? null : null,
      resolution: ticket.resolution,
      resolvedAt: ticket.resolved_at,
      createdAt: ticket.created_at,
      updatedAt: ticket.updated_at,
    },
    messages: messages.map((m) => ({
      id: m.id,
      authorId: m.author_profile_id,
      authorName: m.author_profile_id ? profiles[m.author_profile_id] ?? null : null,
      body: m.body,
      isInternal: m.is_internal,
      createdAt: m.created_at,
    })),
  };
}

export interface AdminSupportTicketPatch {
  status?: SupportTicketStatus;
  priority?: SupportTicketPriority;
  assignedTo?: string | null;
  resolution?: string | null;
}

/**
 * Updates a ticket's triage fields.
 *
 * `resolved_at` is derived, not passed: a ticket that reaches `resolved`/`closed`
 * is stamped once (a re-save does not move the timestamp), and one reopened back
 * to `open`/`pending` has the stamp cleared. Letting the caller set it invites a
 * "resolved at" that disagrees with the status.
 */
export async function updateSupportTicket(
  id: string,
  patch: AdminSupportTicketPatch,
  supabase: ServerClient = createServerClient()
): Promise<SupportTicket> {
  const row: Database['public']['Tables']['support_tickets']['Update'] = {};
  if (patch.priority !== undefined) row.priority = patch.priority;
  if (patch.assignedTo !== undefined) row.assigned_to = patch.assignedTo;
  if (patch.resolution !== undefined) row.resolution = patch.resolution;
  if (patch.status !== undefined) {
    row.status = patch.status;
    row.resolved_at =
      patch.status === 'resolved' || patch.status === 'closed' ? new Date().toISOString() : null;
  }

  const { data, error } = await supabase
    .from('support_tickets')
    .update(row)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as SupportTicket;
}

/** Appends one message to a ticket's thread. */
export async function addSupportMessage(
  ticketId: string,
  input: { authorProfileId: string; body: string; isInternal?: boolean },
  supabase: ServerClient = createServerClient()
): Promise<SupportMessage> {
  const { data, error } = await supabase
    .from('support_messages')
    .insert({
      ticket_id: ticketId,
      author_profile_id: input.authorProfileId,
      body: input.body,
      is_internal: input.isInternal ?? false,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as SupportMessage;
}

// ── Disputes ───────────────────────────────────────────────

export interface AdminDisputeListItem {
  id: string;
  bookingId: string;
  bookingNumber: string | null;
  reason: string;
  description: string | null;
  status: DisputeStatus;
  resolution: string | null;
  raisedById: string | null;
  raisedByName: string | null;
  resolvedById: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminDisputeFilters {
  status?: DisputeStatus;
  /** Booking-number substring. */
  q?: string;
  limit?: number;
  offset?: number;
}

export async function listAdminDisputes(
  filters: AdminDisputeFilters = {},
  supabase: ServerClient = createServerClient()
): Promise<{ disputes: AdminDisputeListItem[]; total: number }> {
  const limit = filters.limit ?? 25;
  const offset = filters.offset ?? 0;

  // `q` matches the booking number, which lives on `bookings` — so resolve it
  // to a set of booking ids first. No matching number, no matching disputes.
  let bookingScope: string[] | null = null;
  if (filters.q) {
    const { data: matching, error: scopeError } = await supabase
      .from('bookings')
      .select('id')
      .ilike('booking_number', `%${filters.q}%`)
      .limit(100);
    if (scopeError) throw scopeError;
    bookingScope = (matching ?? []).map((b) => b.id);
    if (bookingScope.length === 0) return { disputes: [], total: 0 };
  }

  let query = supabase.from('disputes').select('*', { count: 'exact' });
  if (filters.status) query = query.eq('status', filters.status);
  if (bookingScope) query = query.in('booking_id', bookingScope);

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const rows = (data ?? []) as Dispute[];
  if (rows.length === 0) return { disputes: [], total: count ?? 0 };

  const [profiles, bookings] = await Promise.all([
    namesById(supabase, rows.flatMap((r) => [r.raised_by, r.resolved_by])),
    bookingNumbers(supabase, rows.map((r) => r.booking_id)),
  ]);

  return {
    disputes: rows.map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      bookingNumber: bookings[r.booking_id] ?? null,
      reason: r.reason,
      description: r.description,
      status: r.status,
      resolution: r.resolution,
      raisedById: r.raised_by,
      raisedByName: r.raised_by ? profiles[r.raised_by] ?? null : null,
      resolvedById: r.resolved_by,
      resolvedByName: r.resolved_by ? profiles[r.resolved_by] ?? null : null,
      resolvedAt: r.resolved_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    total: count ?? rows.length,
  };
}

/** One dispute, projected like a list row. `null` when the id matches nothing. */
export async function getAdminDispute(
  id: string,
  supabase: ServerClient = createServerClient()
): Promise<AdminDisputeListItem | null> {
  const { data, error } = await supabase
    .from('disputes')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const dispute = data as Dispute;
  const [profiles, bookings] = await Promise.all([
    namesById(supabase, [dispute.raised_by, dispute.resolved_by]),
    bookingNumbers(supabase, [dispute.booking_id]),
  ]);

  return {
    id: dispute.id,
    bookingId: dispute.booking_id,
    bookingNumber: bookings[dispute.booking_id] ?? null,
    reason: dispute.reason,
    description: dispute.description,
    status: dispute.status,
    resolution: dispute.resolution,
    raisedById: dispute.raised_by,
    raisedByName: dispute.raised_by ? profiles[dispute.raised_by] ?? null : null,
    resolvedById: dispute.resolved_by,
    resolvedByName: dispute.resolved_by ? profiles[dispute.resolved_by] ?? null : null,
    resolvedAt: dispute.resolved_at,
    createdAt: dispute.created_at,
    updatedAt: dispute.updated_at,
  };
}

/**
 * Adjudicates a dispute. `status` is the decision; the resolver and the moment
 * are stamped here, not passed, so "resolved" and "resolved by X at T" can never
 * disagree. Reopening (`open`/`investigating`) clears the stamp.
 */
export async function resolveDispute(
  id: string,
  decision: { status: DisputeStatus; resolution?: string | null; resolvedBy: string },
  supabase: ServerClient = createServerClient()
): Promise<Dispute> {
  const closed = decision.status === 'resolved' || decision.status === 'rejected';
  const { data, error } = await supabase
    .from('disputes')
    .update({
      status: decision.status,
      resolution: decision.resolution ?? null,
      resolved_by: closed ? decision.resolvedBy : null,
      resolved_at: closed ? new Date().toISOString() : null,
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as Dispute;
}
