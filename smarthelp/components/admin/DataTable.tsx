'use client';

import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  /** Applied to both the header cell and each body cell. */
  className?: string;
  render: (row: T) => ReactNode;
}

/**
 * The console's table (§20.11, D5).
 *
 * Deliberately hand-written rather than a data-grid dependency: every admin
 * list is server-paginated, so the only behaviour a table needs here is to
 * render rows and announce an empty state. Sorting and filtering are query
 * parameters, not client state — a console that re-sorts a page it does not
 * hold the rest of is a console that lies about the order.
 *
 * A responsive wrapper keeps a wide table scrollable on a narrow screen without
 * the page itself scrolling sideways.
 */
export default function DataTable<T>({
  columns,
  rows,
  keyOf,
  caption,
  empty = 'Nothing to show.',
  selection,
}: {
  columns: Column<T>[];
  rows: T[];
  keyOf: (row: T) => string;
  caption: string;
  empty?: string;
  /**
   * When present, a leading checkbox column is rendered. Selection is offered
   * only for actions that act on many rows at once (§20.13's KYC queue); a list
   * whose only action is "open" does not pass it.
   */
  selection?: {
    selected: string[];
    onChange: (next: string[]) => void;
  };
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
        <p className="text-sm text-gray-600">{empty}</p>
      </div>
    );
  }

  const pageKeys = rows.map(keyOf);
  const allSelected = pageKeys.every((key) => selection?.selected.includes(key));

  const toggleAll = () => {
    if (!selection) return;
    selection.onChange(allSelected ? [] : pageKeys);
  };

  const toggleOne = (key: string) => {
    if (!selection) return;
    selection.onChange(
      selection.selected.includes(key)
        ? selection.selected.filter((k) => k !== key)
        : [...selection.selected, key]
    );
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
      <table className="min-w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-gray-50">
          <tr className="text-left">
            {selection && (
              <th scope="col" className="w-10 px-4 py-2.5">
                <input
                  type="checkbox"
                  aria-label="Select all on this page"
                  checked={allSelected}
                  onChange={toggleAll}
                />
              </th>
            )}
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={`px-4 py-2.5 font-medium text-gray-500 ${col.className ?? ''}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row) => {
            const key = keyOf(row);
            return (
              <tr key={key} className="hover:bg-gray-50">
                {selection && (
                  <td className="w-10 px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select row ${key}`}
                      checked={selection.selected.includes(key)}
                      onChange={() => toggleOne(key)}
                    />
                  </td>
                )}
                {columns.map((col) => (
                  <td key={col.key} className={`px-4 py-3 align-middle ${col.className ?? ''}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
