'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import DataTable, { type Column } from '@/components/admin/DataTable';
import StatusPill from '@/components/admin/StatusPill';
import { useAuth } from '@/contexts/AuthContext';
import { fetchAdminBookings, type AdminBookingListItem } from '@/lib/adminClient';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

const STATUSES = [
  'paid',
  'searching',
  'assigned',
  'accepted',
  'on_the_way',
  'arrived',
  'otp_verified',
  'in_progress',
  'completed',
  'cancelled',
  'refund_pending',
  'refunded',
  'disputed',
  'no_show',
  'closed',
] as const;

const PAGE_SIZE = 25;
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

const dateFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export default function AdminBookings() {
  const { roleLabel } = useAuth();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AdminBookingListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    fetchAdminBookings({ status: status || undefined, q: q || undefined, limit: PAGE_SIZE, offset })
      .then((res) => {
        setRows(res.bookings);
        setTotal(res.total);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [status, q, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const columns: Column<AdminBookingListItem>[] = [
    {
      key: 'number',
      header: 'Booking',
      render: (row) => (
        <Link href={`/admin/bookings/${row.id}`} className="font-medium text-blue-700 hover:underline">
          {row.bookingNumber}
        </Link>
      ),
    },
    { key: 'customer', header: 'Customer', render: (row) => row.customerName ?? '—' },
    { key: 'professional', header: 'Professional', render: (row) => row.professionalName ?? 'Unassigned' },
    { key: 'service', header: 'Service', render: (row) => row.serviceName ?? '—' },
    { key: 'status', header: 'Status', render: (row) => <StatusPill status={row.status} /> },
    {
      key: 'when',
      header: 'Scheduled / created',
      render: (row) =>
        row.scheduledStartAt ? dateFmt.format(new Date(row.scheduledStartAt)) : dateFmt.format(new Date(row.createdAt)),
    },
    {
      key: 'total',
      header: 'Total',
      className: 'text-right',
      render: (row) => <span className="tabular-nums">{inr.format(row.totalAmount)}</span>,
    },
  ];

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell role="admin" eyebrow={roleLabel ?? 'Operations'} title="Bookings">
        <div className="space-y-4">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setOffset(0);
              load();
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">Status</span>
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setOffset(0);
                }}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All statuses</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">Booking number</span>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="SH-20260101-…"
                className="w-full min-w-48 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              />
            </label>

            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Search
            </button>
          </form>

          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
              We could not load the booking queue. Try again.
            </div>
          ) : (
            <>
              <DataTable
                columns={columns}
                rows={rows}
                keyOf={(row) => row.id}
                caption="Booking queue"
                empty={loading ? 'Loading…' : 'No bookings match these filters.'}
              />

              <div className="flex items-center justify-between text-sm text-gray-600">
                <span>
                  {total} booking{total === 1 ? '' : 's'} · page {page} of {pages}
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
