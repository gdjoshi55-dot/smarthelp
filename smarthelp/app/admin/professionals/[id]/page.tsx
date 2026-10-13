'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import StatusPill from '@/components/admin/StatusPill';
import ConfirmationDialog from '@/components/ui/ConfirmationDialog';
import { useAuth } from '@/contexts/AuthContext';
import { fetchAdminProfessional, setProfessionalSuspended, type AdminProfessionalDetail } from '@/lib/adminClient';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const dt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' });

export default function AdminProfessionalDetailPage() {
  const { roleLabel, hasCapability } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [detail, setDetail] = useState<AdminProfessionalDetail | null>(null);
  const [error, setError] = useState(false);
  const [confirmingSuspend, setConfirmingSuspend] = useState(false);
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSuspend = hasCapability('pro.suspend');

  const load = () => {
    setError(false);
    fetchAdminProfessional(id)
      .then(setDetail)
      .catch(() => setError(true));
  };

  useEffect(load, [id]);

  const pro = detail?.professional;
  const suspended = Boolean(pro?.suspended_reason);

  const applySuspension = async (next: boolean) => {
    setBusy(true);
    setActionError(null);
    try {
      await setProfessionalSuspended(id, { suspended: next, reason: reason.trim() || null });
      setConfirmingSuspend(false);
      setReason('');
      setDetail(await fetchAdminProfessional(id));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'The change could not be applied.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell
        role="admin"
        eyebrow={roleLabel ?? 'Operations'}
        title={detail?.profile?.full_name ?? 'Professional'}
      >
        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
            We could not load this professional.
          </div>
        ) : !detail || !pro ? (
          <p className="text-sm text-gray-600">Loading…</p>
        ) : (
          <div className="space-y-6">
            <section className="rounded-2xl bg-white p-6 shadow-xl">
              <div className="flex flex-wrap items-center gap-3">
                <StatusPill status={pro.verification_status} />
                <StatusPill status={pro.availability_status} />
                {pro.employee_code && <span className="text-sm text-gray-500">{pro.employee_code}</span>}
              </div>

              <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Phone" value={detail.profile?.phone ?? '—'} />
                <Field label="Email" value={detail.profile?.email ?? '—'} />
                <Field label="Rating" value={pro.rating != null ? `${pro.rating.toFixed(1)} (${pro.rating_count})` : '—'} />
                <Field label="Completed jobs" value={String(pro.completed_jobs)} />
                <Field label="Cancelled jobs" value={String(pro.cancelled_jobs)} />
                <Field label="No-shows" value={String(pro.no_shows)} />
                <Field label="Offers / accepted" value={`${pro.total_offers} / ${pro.accepted_offers}`} />
                <Field label="Commission" value={`${(Number(pro.commission_pct) * 100).toFixed(0)}%`} />
                <Field label="Experience" value={`${pro.experience_months} months`} />
                <Field label="KYC verified" value={pro.kyc_verified_at ? dt.format(new Date(pro.kyc_verified_at)) : '—'} />
                <Field label="Onboarded" value={pro.onboarded_at ? dt.format(new Date(pro.onboarded_at)) : '—'} />
                <Field label="Joined" value={dt.format(new Date(pro.created_at))} />
              </dl>

              {pro.suspended_reason && (
                <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800">
                  Suspended: {pro.suspended_reason}
                </p>
              )}
            </section>

            <section className="rounded-2xl bg-white p-6 shadow-xl">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-gray-900">Marketplace access</h2>
                {canSuspend ? (
                  suspended ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setActionError(null);
                        applySuspension(false);
                      }}
                      className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                    >
                      Reactivate
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setConfirmingSuspend(true);
                        setReason('');
                        setActionError(null);
                      }}
                      className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                    >
                      Suspend
                    </button>
                  )
                ) : (
                  <span className="text-sm text-gray-500">Admin only</span>
                )}
              </div>
              <p className="mt-2 text-sm text-gray-600">
                {suspended
                  ? 'This professional is suspended and is not offered new jobs.'
                  : 'This professional is active and can receive offers.'}
              </p>
              {actionError && (
                <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">
                  {actionError}
                </p>
              )}
            </section>

            <section className="rounded-2xl bg-white p-6 shadow-xl">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-gray-900">KYC documents</h2>
                <Link
                  href={`/admin/professionals/${id}/kyc-review`}
                  className="text-sm font-medium text-blue-700 hover:underline"
                >
                  Open review queue →
                </Link>
              </div>
              <p className="mt-1 text-sm text-gray-600">
                Review each document from the KYC queue — this is the read view.
              </p>
              <ul className="mt-3 divide-y divide-gray-100">
                {detail.documents.map((doc) => (
                  <li key={doc.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span className="text-gray-900 capitalize">{doc.doc_type.replace(/_/g, ' ')}</span>
                    <StatusPill status={doc.status} />
                    <span className="text-xs text-gray-500">
                      {doc.reviewed_at ? `Reviewed ${dt.format(new Date(doc.reviewed_at))}` : 'Awaiting review'}
                    </span>
                  </li>
                ))}
                {detail.documents.length === 0 && <li className="py-2 text-sm text-gray-500">No documents.</li>}
              </ul>
            </section>

            <section className="rounded-2xl bg-white p-6 shadow-xl">
              <h2 className="text-base font-semibold text-gray-900">Recent jobs</h2>
              <ul className="mt-3 divide-y divide-gray-100">
                {detail.recentBookings.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <Link href={`/admin/bookings/${b.id}`} className="font-medium text-blue-700 hover:underline">
                      {b.bookingNumber}
                    </Link>
                    <span className="text-gray-600">{b.serviceName ?? '—'}</span>
                    <StatusPill status={b.status} />
                    <span className="tabular-nums text-gray-700">{inr.format(b.totalAmount)}</span>
                  </li>
                ))}
                {detail.recentBookings.length === 0 && (
                  <li className="py-2 text-sm text-gray-500">No jobs yet.</li>
                )}
              </ul>
            </section>
          </div>
        )}
        <ConfirmationDialog
          isOpen={confirmingSuspend}
          onClose={() => setConfirmingSuspend(false)}
          onConfirm={() => {
            if (reason.trim().length === 0) {
              setActionError('A suspension needs a reason that will be recorded.');
              return;
            }
            applySuspension(true);
          }}
          title="Suspend this professional?"
          message="They are taken offline and will not be offered new jobs. You can reactivate them later."
          confirmText="Suspend"
          type="danger"
          isLoading={busy}
        >
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Reason for suspension"
            className="w-full rounded-lg border border-gray-300 p-2 text-sm"
          />
        </ConfirmationDialog>
      </RoleShell>
    </AuthGuard>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-gray-900">{value}</dd>
    </div>
  );
}
