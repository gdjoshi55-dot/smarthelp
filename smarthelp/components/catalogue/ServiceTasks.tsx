'use client';

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import type { ServiceTaskView } from '@/lib/catalogue';

/**
 * "What's included" and "What's not" — the scope accordion of §20.3.
 *
 * Both lists come from `service_tasks`; nothing here is hardcoded, because a
 * scope list that disagrees with the database becomes a support ticket.
 * Included uses a green check, excluded a muted cross, and the two are never
 * mixed in one list: a reader who cannot tell which column they are in will read
 * the wrong one.
 *
 * It is a client component only because it collapses on tap. Both sections open
 * by default on the detail screen — a customer looking for what is *not*
 * included should not have to find it.
 */

export function ServiceTasks({ tasks }: { tasks: ServiceTaskView[] }) {
  const included = tasks.filter((task) => task.kind === 'included');
  const excluded = tasks.filter((task) => task.kind === 'excluded');
  const [open, setOpen] = useState(true);

  if (included.length === 0 && excluded.length === 0) return null;

  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-gray-200 bg-white">
      <h2 className="sr-only">What this job covers</h2>

      {included.length > 0 ? (
        <ScopeList
          title="What's included"
          open={open}
          onToggle={() => setOpen((value) => !value)}
          tone="included"
          items={included}
        />
      ) : null}

      {excluded.length > 0 ? (
        <ScopeList
          title="What's not included"
          open
          tone="excluded"
          items={excluded}
          className={included.length > 0 ? 'border-t border-gray-100' : ''}
        />
      ) : null}
    </section>
  );
}

function ScopeList({
  title,
  items,
  open,
  onToggle,
  tone,
  className = '',
}: {
  title: string;
  items: ServiceTaskView[];
  open: boolean;
  onToggle?: () => void;
  tone: 'included' | 'excluded';
  className?: string;
}) {
  const Icon = tone === 'included' ? Check : X;

  return (
    <div className={className}>
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <span className="text-sm font-semibold text-gray-900">{title}</span>
          <span className="text-sm text-gray-500">{open ? 'Hide' : 'Show'}</span>
        </button>
      ) : (
        <p className="px-4 py-3 text-sm font-semibold text-gray-900">{title}</p>
      )}

      {open ? (
        <ul className="space-y-2 px-4 pb-4">
          {items.map((item) => (
            <li key={`${item.kind}-${item.sortOrder}-${item.label}`} className="flex gap-2.5">
              <Icon
                className={`mt-0.5 h-4 w-4 shrink-0 ${
                  tone === 'included' ? 'text-green-600' : 'text-gray-400'
                }`}
                aria-hidden="true"
              />
              <span
                className={
                  tone === 'excluded'
                    ? 'text-sm text-gray-500 line-through decoration-gray-300'
                    : 'text-sm text-gray-700'
                }
              >
                {item.label}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
