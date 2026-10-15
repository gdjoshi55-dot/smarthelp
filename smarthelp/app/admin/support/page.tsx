'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import DataTable, { type Column } from '@/components/admin/DataTable';
import StatusPill from '@/components/admin/StatusPill';
import { useAuth } from '@/contexts/AuthContext';
import {
  fetchSupportTickets,
  type AdminSupportTicketListItem,
  type SupportTicketPriority,
  type SupportTicketStatus,
} from '@/lib/adminClient';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];
const PAGE_SIZE = 25;
const dt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

const PRIORITY_TONE: Record<SupportTicketPriority, string> = {
  low: 'text-gray-500',
  normal: 'text-gray-700',
  high: 'text-amber-700',
  urgent: 'text-red-700 font-semibold',
};

/**
 * The support queue (§24, §31.1). Staff read it; writing a ticket is
 * `ticket.write` on the detail screen. Filters are query parameters.
 */
export default function AdminSupport() {
  const { roleLabel } = useAuth();

  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);

  const [rows, setRows] = useState<AdminSupportTicketListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    fetchSupportTickets({
      status: (status || undefined) as SupportTicketStatus | undefined,
      priority: (priority || undefined) as SupportTicketPriority | undefined,
      q: q || undefined,
      limit: PAGE_SIZE,
      offset,
    })
      .then((res) => {
        setRows(res.tickets);
        setTotal(res.total);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [status, priority, q, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const columns: Column<AdminSupportTicketListItem>[] = [
    {
      key: 'subject',
      header: 'Subject',
      render: (r) => (
        <Link href={`/admin/support/${r.id}`} className="font-medium text-blue-700 hover:underline">
          {r.subject}
        </Link>
      ),
    },
    { key: 'booking', header: 'Booking', render: (r) => r.bookingNumber ?? '—' },
    { key: 'raised', header: 'Raised by', render: (r) => r.raisedByName ?? '—' },
    { key: 'assignee', header: 'Assigned', render: (r) => r.assignedToName ?? 'Unassigned' },
    {
      key: 'priority',
      header: 'Priority',
      render: (r) => <span className={PRIORITY_TONE[r.priority]}>{r.priority}</span>,
    },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
    { key: 'updated', header: 'Updated', render: (r) => dt.format(new Date(r.updatedAt)) },
  ];

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell role="admin" eyebrow={roleLabel ?? 'Operations'} title="Support">
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label="Status"
              value={status}
              onChange={(v) => {
                setStatus(v);
                setOffset(0);
              }}
              options={['open', 'pending', 'resolved', 'closed']}
            />
            <Select
              label="Priority"
              value={priority}
              onChange={(v) => {
                setPriority(v);
                setOffset(0);
              }}
              options={['low', 'normal', 'high', 'urgent']}
            />
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">Subject contains</span>
              <input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setOffset(0);
                }}
                className="w-full min-w-48 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              />
            </label>
          </div>

          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
              We could not load the support queue. Try again.
            </div>
          ) : (
            <>
              <DataTable
                columns={columns}
                rows={rows}
                keyOf={(r) => r.id}
                caption="Support tickets"
                empty={loading ? 'Loading…' : 'No tickets match these filters.'}
              />
              <div className="flex items-center justify-between text-sm text-gray-600">
                <span>
                  {total} ticket{total === 1 ? '' : 's'} · page {page} of {pages}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 font-medium disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={offset + PAGE_SIZE >= total}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 font-medium disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </RoleShell>
    </AuthGuard>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-gray-700">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm capitalize"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o} className="capitalize">
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
