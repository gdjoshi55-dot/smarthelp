'use client';

import Link from 'next/link';
import type { CategorySummary } from '@/lib/catalogue';

/**
 * The category pills of §20.1 / §20.2.
 *
 * Without an `onSelect` a pill is a link, because a category is a URL:
 * `/services?category=cleaning` is what somebody bookmarks, shares, and comes
 * back to. With one — on the catalogue screen, where filtering without a
 * navigation is what makes the grid feel instant — it is a button instead,
 * because a link that cancels its own navigation is a control pretending to be a
 * link, and screen readers announce it as one.
 */

const PILL_BASE =
  'inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1';
const PILL_ACTIVE = 'border-blue-600 bg-blue-600 text-white';
const PILL_IDLE = 'border-gray-300 bg-white text-gray-700 hover:border-blue-400 hover:text-blue-700';

export function CategoryPills({
  categories,
  activeSlug,
  baseHref = '/services',
  onSelect,
  className = '',
}: {
  categories: CategorySummary[];
  /** The category currently being filtered, or `null` for "all". */
  activeSlug?: string | null;
  baseHref?: string;
  /** When given, the pill filters in place instead of navigating. */
  onSelect?: (slug: string | null) => void;
  className?: string;
}) {
  if (categories.length === 0) return null;

  const tone = (active: boolean) =>
    `${PILL_BASE} ${active ? PILL_ACTIVE : PILL_IDLE}`;

  const count = (value: number | null, active: boolean) =>
    value != null && value > 0 ? (
      <span className={active ? 'text-blue-100' : 'text-gray-400'}>{value}</span>
    ) : null;

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {onSelect ? (
        <button
          type="button"
          onClick={() => onSelect(null)}
          aria-pressed={!activeSlug}
          className={tone(!activeSlug)}
        >
          All
        </button>
      ) : (
        <Link href={baseHref} aria-current={!activeSlug ? 'page' : undefined} className={tone(!activeSlug)}>
          All
        </Link>
      )}

      {categories.map((category) => {
        const active = activeSlug === category.slug;
        if (onSelect) {
          return (
            <button
              key={category.id}
              type="button"
              onClick={() => onSelect(category.slug)}
              aria-pressed={active}
              className={tone(active)}
            >
              {category.name}
              {count(category.serviceCount, active)}
            </button>
          );
        }
        return (
          <Link
            key={category.id}
            href={`${baseHref}?category=${category.slug}`}
            aria-current={active ? 'page' : undefined}
            className={tone(active)}
          >
            {category.name}
            {count(category.serviceCount, active)}
          </Link>
        );
      })}
    </div>
  );
}
