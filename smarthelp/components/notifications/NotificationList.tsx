'use client';

import LoadingSpinner from '@/components/ui/LoadingSpinner';
import type { NotificationListItem } from '@/lib/notificationClient';

/**
 * The bell's contents, and any full-page rendering of the same feed (§27).
 *
 * Presentational on purpose: the owner of the data is `NotificationBell` (or a
 * page), which is what knows how to fetch, poll and mark read. Keeping the list
 * dumb means the same rows render in a dropdown and on a page without two
 * versions of "what a notification looks like".
 */
export function NotificationList({
  items,
  unread,
  loading,
  error,
  onRead,
  onReadAll,
  onSelect,
  emptyHint = 'You are all caught up.',
}: {
  items: NotificationListItem[];
  unread: number;
  loading: boolean;
  error: boolean;
  onRead: (id: string) => void;
  onReadAll: () => void;
  onSelect?: (item: NotificationListItem) => void;
  emptyHint?: string;
}) {
  if (loading && items.length === 0) {
    return (
      <div className="flex items-center justify-center p-8" role="status" aria-busy="true">
        <LoadingSpinner size="md" />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2">
        <p className="text-sm font-semibold text-gray-900">Notifications</p>
        <button
          type="button"
          onClick={onReadAll}
          disabled={unread === 0}
          className="text-xs font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
        >
          Mark all read
        </button>
      </div>

      {error && items.length === 0 ? (
        <p className="p-4 text-sm text-red-700">
          We could not load your notifications. Try again shortly.
        </p>
      ) : items.length === 0 ? (
        <p className="p-4 text-sm text-gray-500">{emptyHint}</p>
      ) : (
        <ul className="max-h-96 divide-y divide-gray-100 overflow-y-auto">
          {items.map((item) => {
            const isUnread = item.readAt === null;
            const content = (
              <>
                <span className="flex items-start gap-2">
                  {isUnread ? (
                    <span
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-blue-600"
                      aria-hidden="true"
                    />
                  ) : (
                    <span className="mt-1.5 h-2 w-2 shrink-0" aria-hidden="true" />
                  )}
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-gray-900">
                      {item.title ?? item.code}
                    </span>
                    {item.body ? (
                      <span className="mt-0.5 block text-sm text-gray-600">{item.body}</span>
                    ) : null}
                    <span className="mt-0.5 block text-xs text-gray-400">
                      {relativeTime(item.createdAt)}
                    </span>
                  </span>
                </span>
              </>
            );

            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (isUnread) onRead(item.id);
                    onSelect?.(item);
                  }}
                  className={`block w-full px-4 py-3 text-left hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${
                    isUnread ? 'bg-blue-50/40' : ''
                  }`}
                >
                  {content}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** "just now", "5m ago", "3h ago", "2d ago" — enough to place a row in time. */
function relativeTime(value: string): string {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
