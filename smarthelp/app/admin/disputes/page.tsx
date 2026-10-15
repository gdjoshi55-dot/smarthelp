'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import DataTable, { type Column } from '@/components/admin/DataTable';
import StatusPill from '@/components/admin/StatusPill';
import { useAuth } from '@/contexts/AuthContext';
import {
  fetchAdminDisputes,
  resolveAdminDispute,
  type AdminDisputeListItem,
  type DisputeStatus,
} from '@/lib/adminClient';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];
const PAGE_SIZE = 25;
const dt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The dispute queue (§24, §25.10, §31.1). Staff read it; `dispute.resolve`
 * (ops/admin) adjudicates. The resolve panel is inline, because the decision and
 * its note are one act.
 */
export default function AdminDisputes() {
  const { roleLabel, hasCapability } = useAuth();
  const canResolve = hasCapability('dispute.resolve');

  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);

  const [rows, setRows] = useState<AdminDisputeListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [resolving, setResolving] = useState<AdminDisputeListItem | null>(null);
  const [decision, setDecision] = useState<DisputeStatus>('resolved');
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [flashed, setFlashed] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    fetchAdminDisputes({
      status: (status || undefined) as DisputeStatus | undefined,
      q: q || undefined,
      limit: PAGE_SIZE,
      offset,
    })
      .then((res) => {
        setRows(res.disputes);
        setTotal(res.total);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [status, q, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async () => {
    if (!resolving) return;
    setBusy(true);
    setActionError(null);
    try {
      await resolveAdminDispute(resolving.id, { status: decision, resolution: resolution || null });
      setResolving(null);
      setResolution('');
      setFlashed('Dispute updated.');
      setTimeout(() => setFlashed(null), 4000);
      load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'The dispute could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<AdminDisputeListItem>[] = [
    { key: 'booking', header: 'Booking', render: (r) => r.bookingNumber ?? '—' },
    { key: 'reason', header: 'Reason', render: (r) => r.reason },
    { key: 'raised', header: 'Raised by', render: (r) => r.raisedByName ?? '—' },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
    { key: 'opened', header: 'Opened', render: (r) => dt.format(new Date(r.createdAt)) },
    {
      key: 'actions',
      header: '',
      render: (r) =>
        canResolve ? (
          <button
            type="button"
            onClick={() => {
              setResolving(r);
              setDecision('resolved');
              setResolution(r.resolution ?? '');
              setActionError(null);
            }}
            className="text-sm font-medium text-blue-700 hover:underline"
          >
            Resolve
          </button>
        ) : null,
    },
  ];

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell role="admin" eyebrow={roleLabel ?? 'Operations'} title="Disputes">
        <div className="space-y-4">
          {!canResolve && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              You can review disputes here, but only operations or an admin can resolve them.
            </p>
          )}
          {flashed && <p className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{flashed}</p>}

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">Status</span>
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setOffset(0);
                }}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm capitalize"
              >
                <option value="">All</option>
                {(['open', 'investigating', 'resolved', 'rejected'] as const).map((s) => (
                  <option key={s} value={s} className="capitalize">
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">Booking number</span>
              <input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setOffset(0);
                }}
                className="w-full min-w-40 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              />
            </label>
          </div>

          {resolving && (
            <form
              className="space-y-3 rounded-2xl border border-blue-200 bg-blue-50/50 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <p className="text-sm font-medium text-gray-900">
                Dispute on booking {resolving.bookingNumber ?? '—'}: {resolving.reason}
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-gray-700">Decision</span>
                  <select value={decision} onChange={(e) => setDecision(e.target.value as DisputeStatus)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
                    <option value="investigating">investigating</option>
                    <option value="resolved">resolved</option>
                    <option value="rejected">rejected</option>
                  </select>
                </label>
                <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">
                  <span className="font-medium text-gray-700">Resolution note</span>
                  <input value={resolution} onChange={(e) => setResolution(e.target.value)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" />
                </label>
              </div>
              {actionError && <p className="text-sm text-red-700">{actionError}</p>}
              <div className="flex gap-3">
                <button type="submit" disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                  Save decision
                </button>
                <button type="button" onClick={() => setResolving(null)} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                  Cancel
                </button>
              </div>
            </form>
          )}

          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
              We could not load the disputes. Try again.
            </div>
          ) : (
            <>
              <DataTable
                columns={columns}
                rows={rows}
                keyOf={(r) => r.id}
                caption="Disputes"
                empty={loading ? 'Loading…' : 'No disputes match these filters.'}
              />
              <div className="flex items-center justify-between text-sm text-gray-600">
                <span>
                  {total} dispute{total === 1 ? '' : 's'} · page {page} of {pages}
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
