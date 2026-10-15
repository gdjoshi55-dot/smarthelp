'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { ChatBubble } from './ChatBubble';
import { useChatChannel } from '@/hooks/use-realtime';
import {
  ChatApiError,
  fetchBookingChat,
  fetchThreadMessages,
  sendMessage,
  type ChatView,
} from '@/lib/chatClient';

/**
 * The booking chat panel (§24.11, §27.1, D3).
 *
 * Mount it with either a `bookingId` (the natural key — the thread is created
 * lazily server-side) or a `threadId` (when the thread is already known). The
 * history loads once, Realtime appends on `chat:{threadId}`, and a 15-second
 * poll is the fallback when the channel is down (§27.3, D4) — so a dropped
 * socket degrades the latency, not the feature.
 *
 * Posting is not optimistic (Interaction Contract 4): the send waits for the
 * server, then the history is refetched, so the sender sees the stored row and
 * its server timestamp rather than a guess. `canPost` is false for staff and
 * for a closed thread, and the composer reflects that rather than hiding the
 * reason.
 */
export function ChatThread({
  bookingId,
  threadId,
  currentUserId,
  emptyHint = 'Chat opens once a professional is assigned.',
}: {
  bookingId?: string;
  threadId?: string;
  currentUserId: string;
  emptyHint?: string;
}) {
  const [view, setView] = useState<ChatView | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const next = bookingId
        ? await fetchBookingChat(bookingId)
        : await fetchThreadMessages(threadId as string);
      setView(next);
      setUnavailable(false);
    } catch (e) {
      if (e instanceof ChatApiError && e.status === 404) {
        setUnavailable(true);
      } else {
        setError(e instanceof Error ? e.message : 'We could not load the conversation.');
      }
    } finally {
      setLoading(false);
    }
  }, [bookingId, threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime: a new message refetches, which resolves the sender's name
  // server-side and keeps one source of truth (the API) rather than merging an
  // append with a poll.
  useChatChannel(view?.thread.id ?? null, () => {
    void load();
  });

  // Polling fallback (§27.3): 15s while the tab is visible.
  useEffect(() => {
    if (!view) return;
    const id = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 15_000);
    return () => window.clearInterval(id);
  }, [view, load]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view?.messages.length]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !view || busy || !view.canPost || view.thread.closedAt) return;
    setBusy(true);
    setError(null);
    try {
      await sendMessage(view.thread.id, { kind: 'text', body: text });
      setDraft('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Your message was not sent. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-2xl bg-white p-8 shadow-xl" role="status" aria-busy="true">
        <LoadingSpinner size="md" />
      </div>
    );
  }

  if (unavailable || !view) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-600 shadow-xl">
        {emptyHint}
      </div>
    );
  }

  const closed = Boolean(view.thread.closedAt);
  const canSend = view.canPost && !closed;

  return (
    <section className="flex flex-col rounded-2xl bg-white shadow-xl" aria-label="Conversation">
      <div
        ref={scrollRef}
        className="flex max-h-96 min-h-48 flex-col gap-2 overflow-y-auto p-4"
        role="log"
        aria-live="polite"
      >
        {view.messages.length === 0 ? (
          <p className="m-auto text-sm text-gray-500">No messages yet. Say hello.</p>
        ) : (
          view.messages.map((m: ChatView['messages'][number]) => (
            <ChatBubble key={m.id} message={m} isOwn={m.senderId === currentUserId} />
          ))
        )}
      </div>

      <div className="border-t border-gray-200 p-3">
        {error ? <p className="mb-2 text-sm text-red-700">{error}</p> : null}
        {!view.canPost ? (
          <p className="text-sm text-gray-500">
            You can read this conversation, but only the customer and their professional can reply.
          </p>
        ) : closed ? (
          <p className="text-sm text-gray-500">This conversation is closed.</p>
        ) : (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label htmlFor="chat-input" className="sr-only">
              Message
            </label>
            <textarea
              id="chat-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              maxLength={4000}
              placeholder="Type a message…"
              className="min-h-11 flex-1 resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            />
            <button
              type="submit"
              disabled={busy || draft.trim().length === 0}
              aria-busy={busy}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              {busy ? <LoadingSpinner size="sm" /> : <Send className="h-4 w-4" aria-hidden="true" />}
              <span className="sr-only sm:not-sr-only">Send</span>
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
