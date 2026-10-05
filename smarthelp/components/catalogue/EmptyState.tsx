import type { ReactNode } from 'react';
import Link from 'next/link';
import { Inbox } from 'lucide-react';

/**
 * The "there is nothing here" state (§31.2).
 *
 * It exists as a component because three booking screens need it — a customer
 * with no bookings, a filter that matched nothing, a checkout with nothing in it —
 * and because the *three cases need different sentences*. "No bookings yet" and
 * "no bookings matching that filter" look identical on a page that renders the
 * same grey box for both, and the second one is the one that makes somebody think
 * their bookings have gone missing.
 *
 * So the caller says which it is, and this picks the copy. It never shows an
 * action that does nothing: a filter that matched nothing offers "clear the
 * filter", not "browse services", which would send them away from the thing they
 * were looking at.
 */
export function EmptyState({
  title,
  message,
  action,
  icon,
}: {
  title: string;
  message: string;
  action?: { href: string; label: string } | null;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center">
      <span className="rounded-full bg-gray-100 p-3 text-gray-400">
        {icon ?? <Inbox className="h-5 w-5" aria-hidden="true" />}
      </span>
      <h3 className="mt-3 text-sm font-semibold text-gray-900">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-gray-600">{message}</p>
      {action ? (
        <Link
          href={action.href}
          className="mt-4 inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}