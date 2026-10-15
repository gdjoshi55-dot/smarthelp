'use client';

import { useCallback, useEffect, useState } from 'react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import DataTable, { type Column } from '@/components/admin/DataTable';
import StatusPill from '@/components/admin/StatusPill';
import ConfirmationDialog from '@/components/ui/ConfirmationDialog';
import { useAuth } from '@/contexts/AuthContext';
import { executeAdminRefund, fetchAdminRefunds, type AdminRefundListItem } from '@/lib/adminClient';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];
const PAGE_SIZE = 25;
const STATUSES = ['requested', 'approved', 'rejected', 'completed', 'failed'] as const;

const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const dt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The refund console (§22, §25.10, §31.1).
 *
 * Any staff member sees the queue; `refund.execute` is the gate on the button.
 * An above-limit refund requested by the same person is refused by the API with
 * `SECOND_APPROVER_REQUIRED`, and the page surfaces that rather than pretending
 * the click failed — dual approval is a rule, not a bug.
 */
export default function AdminPayments() {
  const { roleLabel, hasCapability } = useAuth();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AdminRefundListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [executing, setExecuting] = useState<AdminRefundListItem | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const canExecute = hasCapability('refund.execute');

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    fetchAdminRefunds({
      status: status || undefined,
      q: q || undefined,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
      limit: PAGE_SIZE,
      offset,
    })
      .then((res) => {
        setRows(res.refunds);
        setTotal(res.total);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [status, q, from, to, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const confirmExecute = async () => {
    if (!executing) return;
    setBusy(true);
    setActionError(null);
    try {
      await executeAdminRefund(executing.id, { note: note.trim() || null });
      setExecuting(null);
      setNote('');
      load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'The refund could not be executed.');
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<AdminRefundListItem>[] = [
    {
      key: 'booking',
      header: 'Booking',
      render: (row) => <span className="font-medium text-gray-900">{row.bookingNumber ?? row.bookingId.slice(0, 8)}</span>,
    },
    { key: 'customer', header: 'Customer', render: (row) => row.customerName },
    {
      key: 'amount',
      header: 'Amount',
      className: 'text-right',
      render: (row) => <span className="tabular-nums">{money.format(row.amount)}</span>,
    },
    { key: 'status', header: 'Status', render: (row) => <StatusPill status={row.status} /> },
    { key: 'route', header: 'Route', render: (row) => row.route ?? '—' },
    { key: 'reason', header: 'Reason', render: (row) => <span className="capitalize">{row.reasonCode.replace(/_/g, ' ')}</span> },
    { key: 'requestedBy', header: 'Requested by', render: (row) => row.requestedByName ?? '—' },
    { key: 'requestedAt', header: 'Requested', render: (row) => dt.format(new Date(row.requestedAt)) },
    {
      key: 'action',
      header: '',
      render: (row) =>
        canExecute && (row.status === 'requested' || row.status === 'approved') ? (
          <button
            type="button"
            onClick={() => {
              setExecuting(row);
              setNote('');
              setActionError(null);
            }}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Execute
          </button>
        ) : null,
    },
  ];

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell role="admin" eyebrow={roleLabel ?? 'Operations'} title="Refunds">
        <div className="space-y-4">
          {!canExecute && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              You can review refunds here, but only ops and admins may execute them.
            </p>
          )}

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
                <option value="">All</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">Booking no.</span>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-full min-w-40 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">From</span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">To</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" />
            </label>

            <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
              Search
            </button>
          </form>

          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
              We could not load the refund queue. Try again.
            </div>
          ) : (
            <>
              <DataTable
                columns={columns}
                rows={rows}
                keyOf={(row) => row.id}
                caption="Refund queue"
                empty={loading ? 'Loading…' : 'No refunds match these filters.'}
              />
              <div className="flex items-center justify-between text-sm text-gray-600">
                <span>
                  {total} refund{total === 1 ? '' : 's'} · page {page} of {pages}
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

        <ConfirmationDialog
          isOpen={executing !== null}
          onClose={() => setExecuting(null)}
          onConfirm={confirmExecute}
          title="Execute this refund?"
          message={`This moves ${executing ? money.format(executing.amount) : ''} through the refund route now. Above the support limit, a different staff member must approve it.`}
          confirmText="Execute refund"
          type="warning"
          isLoading={busy}
        >
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Optional note for the audit trail"
            className="w-full rounded-lg border border-gray-300 p-2 text-sm"
          />
          {actionError && <p className="mt-1 text-sm text-red-700">{actionError}</p>}
        </ConfirmationDialog>
      </RoleShell>
    </AuthGuard>
  );
}