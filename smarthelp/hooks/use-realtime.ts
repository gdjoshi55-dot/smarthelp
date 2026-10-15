'use client';

import { useEffect, useState } from 'react';
import { supabase, type Database } from '@/lib/supabase';

/**
 * The client subscription helpers (§27.1, §27.2, D4).
 *
 * Realtime is an **optimisation, not a dependency** (§27.3): every screen that
 * uses one of these also has a polling fallback, and a channel that never
 * connects changes only *how quickly* a screen updates, never whether it does.
 * So each hook is written to be safe to mount on a page that never receives a
 * single event: nothing here gates data, it only calls back with newer data.
 *
 * The browser client authenticates with the user's Supabase session (held in
 * `localStorage`), so a subscription is subject to the same row-level security
 * as a REST read — a channel for a booking a user cannot see delivers nothing.
 *
 * Supabase's channel names are shared server-side; the names below match §27.1
 * (`booking:{id}`, `pro:{id}`, `me:{profileId}`) so a future server broadcast
 * lands on the same channel a client already listens to.
 */

type BookingRow = Database['public']['Tables']['bookings']['Row'];
type NotificationRow = Database['public']['Tables']['notifications']['Row'];
type ChatMessageRow = Database['public']['Tables']['chat_messages']['Row'];

/**
 * `booking:{id}` — the customer, the assigned professional and staff subscribe
 * to the same row. `onChange` receives the new row on every UPDATE, which is the
 * booking's whole status surface (`status`, `professional_id`, `started_at`,
 * `ends_at`, `arrived_at`, `eta_minutes`).
 *
 * The handler is held in a ref-like effect dependency through `onChange` in the
 * dependency list, so a caller that passes an inline arrow re-subscribes on each
 * render. That is acceptable for a page whose parent re-renders rarely (the
 * booking detail), and the alternative — a ref — would silently drop the
 * caller's latest closure. Callers that re-render often should memoise it.
 */
export function useBookingChannel(bookingId: string, onChange: (row: BookingRow) => void): void {
  useEffect(() => {
    if (!bookingId) return;
    const channel = supabase
      .channel(`booking:${bookingId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'bookings', filter: `id=eq.${bookingId}` },
        (payload: { new: unknown }) => onChange(payload.new as BookingRow)
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [bookingId, onChange]);
}

/**
 * `pro:{id}` — the professional's live location and online state during an
 * active booking, delivered through Supabase Presence rather than a table write
 * (a 5-second position is presence, not history).
 *
 * Returns `null` until the first sync with a position, and back to `null` when
 * the professional leaves the channel. The ETA *computation* lives client-side
 * in a later phase; this hook only surfaces the coordinates.
 */
export function useProPresence(proId: string | null): { lat: number; lng: number } | null {
  const [loc, setLoc] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (!proId) {
      setLoc(null);
      return;
    }
    const channel = supabase
      .channel(`pro:${proId}`, { config: { presence: { key: proId } } })
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState()[proId]?.[0] as
          | { lat?: number; lng?: number }
          | undefined;
        if (state && typeof state.lat === 'number' && typeof state.lng === 'number') {
          setLoc({ lat: state.lat, lng: state.lng });
        } else {
          setLoc(null);
        }
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [proId]);

  return loc;
}

/**
 * `me:{profileId}` — the bell. A notification is an INSERT into
 * `public.notifications` filtered to the recipient, so `onInsert` fires for each
 * new row (the code has already written one `in_app` row per event, §27.4).
 *
 * The unread count is the caller's to compute from its own list; this hook only
 * streams the event, so the bell can decide whether to refetch or to prepend.
 * `usePoll`/`useNotifications`'s caller refetches on every insert, which keeps
 * one source of truth (the API) rather than merging two.
 */
export function useNotifications(
  recipientId: string | null,
  onInsert: (row: NotificationRow) => void
): void {
  useEffect(() => {
    if (!recipientId) return;
    const channel = supabase
      .channel(`me:${recipientId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `recipient_id=eq.${recipientId}`,
        },
        (payload: { new: unknown }) => onInsert(payload.new as NotificationRow)
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [recipientId, onInsert]);
}

/**
 * `chat:{threadId}` — a booking's conversation. `onInsert` fires for each new
 * message so the thread can append instantly; the polling fallback (§27.3) in
 * the component covers a channel that never connects.
 */
export function useChatChannel(
  threadId: string | null,
  onInsert: (row: ChatMessageRow) => void
): void {
  useEffect(() => {
    if (!threadId) return;
    const channel = supabase
      .channel(`chat:${threadId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_messages',
          filter: `thread_id=eq.${threadId}`,
        },
        (payload: { new: unknown }) => onInsert(payload.new as ChatMessageRow)
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [threadId, onInsert]);
}
