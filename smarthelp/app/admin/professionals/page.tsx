'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import DataTable, { type Column } from '@/components/admin/DataTable';
import StatusPill from '@/components/admin/StatusPill';
import ConfirmationDialog from '@/components/ui/ConfirmationDialog';
import { useAuth } from '@/contexts/AuthContext';
import {
  bulkKycDecision,
  fetchAdminProfessionals,
  type AdminProfessionalListItem,
} from '@/lib/adminClient';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

const VERIFICATION = ['not_submitted', 'submitted', 'in_review', 'verified', 'rejected', 'expired'] as const;
const AVAILABILITY = ['offline', 'online', 'busy', 'break'] as const;
const PAGE_SIZE = 25;

export default function AdminProfessionals() {
  const { roleLabel, hasCapability } = useAuth();
  const [verification, setVerification] = useState('');
  const [availability, setAvailability] = useState('');
  const [pendingKyc, setPendingKyc] = useState(false);
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AdminProfessionalListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canReview = hasCapability('kyc.review');

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    fetchAdminProfessionals({
      verificationStatus: verification || undefined,
      availabilityStatus: availability || undefined,
      pendingKyc: pendingKyc || undefined,
      q: q || undefined,
      limit: PAGE_SIZE,
      offset,
    })
      .then((res) => {
        setRows(res.professionals);
        setTotal(res.total);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [verification, availability, pendingKyc, q, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const confirmVerify = async () => {
    setBusy(true);
    setBulkError(null);
    try {
      await bulkKycDecision({ professionalIds: selected, verdict: 'verified' });
      setSelected([]);
      setConfirming(false);
      load();
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : 'The batch could not be applied.');
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<AdminProfessionalListItem>[] = [
    {
      key: 'name',
      header: 'Professional',
      render: (row) => (
        <Link href={`/admin/professionals/${row.id}`} className="font-medium text-blue-700 hover:underline">
          {row.name ?? row.id.slice(0, 8)}
        </Link>
      ),
    },
    { key: 'contact', header: 'Contact', render: (row) => row.phone ?? row.email ?? '—' },
    { key: 'verification', header: 'Verification', render: (row) => <StatusPill status={row.verificationStatus} /> },
    { key: 'availability', header: 'Availability', render: (row) => <StatusPill status={row.availabilityStatus} /> },
    {
      key: 'jobs',
      header: 'Completed',
      className: 'text-right',
      render: (row) => <span className="tabular-nums">{row.completedJobs}</span>,
    },
    {
      key: 'offers',
      header: 'Offers (accepted)',
      className: 'text-right',
      render: (row) => (
        <span className="tabular-nums">
          {row.totalOffers} ({row.acceptedOffers})
        </span>
      ),
    },
    {
      key: 'kyc',
      header: '',
      render: (row) => (
        <Link
          href={`/admin/professionals/${row.id}/kyc-review`}
          className="text-sm font-medium text-blue-700 hover:underline"
        >
          Review KYC
        </Link>
      ),
    },
  ];

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell role="admin" eyebrow={roleLabel ?? 'Operations'} title="Professionals">
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
              <span className="font-medium text-gray-700">Verification</span>
              <select
                value={verification}
                onChange={(e) => {
                  setVerification(e.target.value);
                  setOffset(0);
                }}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All</option>
                {VERIFICATION.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">Availability</span>
              <select
                value={availability}
                onChange={(e) => {
                  setAvailability(e.target.value);
                  setOffset(0);
                }}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All</option>
                {AVAILABILITY.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">Name</span>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-full min-w-48 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              />
            </label>

            <label className="flex items-center gap-2 pb-2 text-sm font-medium text-gray-700">
              <input
                type="checkbox"
                checked={pendingKyc}
                onChange={(e) => {
                  setPendingKyc(e.target.checked);
                  setOffset(0);
                }}
              />
              Awaiting KYC only
            </label>

            <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
              Search
            </button>
          </form>

          {canReview && selected.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm">
              <span className="font-medium text-blue-900">{selected.length} selected</span>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700"
              >
                Verify selected
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelected([]);
                  setBulkError(null);
                }}
                className="text-blue-800 hover:underline"
              >
                Clear
              </button>
              {bulkError && <span className="text-red-700">{bulkError}</span>}
            </div>
          )}

          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
              We could not load the roster. Try again.
            </div>
          ) : (
            <>
              <DataTable
                columns={columns}
                rows={rows}
                keyOf={(row) => row.id}
                caption="Professional roster"
                empty={loading ? 'Loading…' : 'No professionals match these filters.'}
                selection={canReview ? { selected, onChange: setSelected } : undefined}
              />

              <div className="flex items-center justify-between text-sm text-gray-600">
                <span>
                  {total} professional{total === 1 ? '' : 's'} · page {page} of {pages}
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
          isOpen={confirming}
          onClose={() => setConfirming(false)}
          onConfirm={confirmVerify}
          title="Verify selected professionals?"
          message={`This verifies the pending documents of ${selected.length} professional${
            selected.length === 1 ? '' : 's'
          } and rolls up their verification status. It cannot be undone here.`}
          confirmText="Verify selected"
          type="warning"
          isLoading={busy}
        />
      </RoleShell>
    </AuthGuard>
  );
}
