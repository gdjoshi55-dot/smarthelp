'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { usePoll } from '@/components/professional/usePoll';
import { useNotifications } from '@/hooks/use-realtime';
import { NotificationList } from './NotificationList';
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '@/lib/notificationClient';

/**
 * The bell (§27).
 *
 * A 15-second poll is the baseline and Realtime is the accelerator (§27.3, D4):
 * an insert on `me:{profileId}` triggers an immediate refetch, so the badge moves
 * in about a second when the channel is up, and within the poll interval when it
 * is not. Reading a row is a server call followed by a refetch, never an
 * optimistic flip (Interaction Contract 4) — the unread count is the server's to
 * report.
 *
 * The polling hook is shared with the professional shell, so this reuses the same
 * overlap and visibility discipline rather than a second copy of it.
 */
export function NotificationBell() {
  const { profile } = useAuth();
  const enabled = Boolean(profile?.id);

  const poll = usePoll(fetchNotifications, { enabled, intervalMs: 15_000 });
  const { data, refresh } = poll;
  const unread = data?.unread ?? 0;

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Realtime: a new row for this recipient refreshes the feed at once.
  const onInsert = useCallback(() => {
    void refresh();
  }, [refresh]);
  useNotifications(profile?.id ?? null, onInsert);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleRead = useCallback(
    async (id: string) => {
      try {
        await markNotificationRead(id);
      } finally {
        await refresh();
      }
    },
    [refresh]
  );

  const handleReadAll = useCallback(async () => {
    try {
      await markAllNotificationsRead();
    } finally {
      await refresh();
    }
  }, [refresh]);

  if (!enabled) return null;

  const badge = unread > 9 ? '9+' : String(unread);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        className="relative inline-flex items-center justify-center rounded-lg p-2 text-gray-700 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-4 text-white">
            {badge}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl"
        >
          <NotificationList
            items={data?.items ?? []}
            unread={unread}
            loading={poll.loading}
            error={poll.error}
            onRead={(id) => void handleRead(id)}
            onReadAll={() => void handleReadAll()}
            onSelect={() => setOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}
