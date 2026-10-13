'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import StatusPill from '@/components/admin/StatusPill';
import { useAuth } from '@/contexts/AuthContext';
import {
  AdminApiError,
  assignAdminBooking,
  cancelAdminBooking,
  fetchAdminBooking,
  fetchAdminProfessionals,
  type AdminBookingDetail,
  type AdminProfessionalListItem,
} from '@/lib/adminClient';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const dt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

function money(value: string | number): string {
  const n = typeof value === 'number' ? value : Number(value);
  return inr.format(Number.isFinite(n) ? n : 0);
}

export default function AdminBookingDetailPage() {
  const { roleLabel, hasCapability } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [detail, setDetail] = useState<AdminBookingDetail | null>(null);
  const [error, setError] = useState(false);

  const canCancel = hasCapability('booking.cancel.any');
  const canAssign = hasCapability('booking.assign');

  const load = useCallback(() => {
    setError(false);
    fetchAdminBooking(id)
      .then(setDetail)
      .catch(() => setError(true));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const booking = detail?.booking;

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell
        role="admin"
        eyebrow={roleLabel ?? 'Operations'}
        title={booking ? `Booking ${booking.booking_number}` : 'Booking'}
      >
        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
            We could not load this booking.
          </div>
        ) : !detail || !booking ? (
          <p className="text-sm text-gray-600">Loading…</p>
        ) : (
          <div className="space-y-6">
            <section className="rounded-2xl bg-white p-6 shadow-xl">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <StatusPill status={booking.status} />
                  <span className="text-sm text-gray-500 capitalize">{booking.booking_type}</span>
                  <span className="text-sm text-gray-500">v{String(booking.version)}</span>
                </div>
                <p className="text-lg font-semibold text-gray-900 tabular-nums">{money(booking.total_amount)}</p>
              </div>

              <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Customer" value={detail.customer?.name ?? '—'} />
                <Field label="Professional" value={detail.professional?.name ?? 'Unassigned'} />
                <Field
                  label="Scheduled"
                  value={booking.scheduled_start_at ? dt.format(new Date(booking.scheduled_start_at)) : 'Instant'}
                />
                <Field label="Subtotal" value={money(booking.subtotal)} />
                <Field label="Platform fee" value={money(booking.platform_fee)} />
                <Field label="Tax" value={money(booking.tax)} />
                <Field label="Discount" value={money(booking.discount)} />
                <Field label="Created" value={dt.format(new Date(booking.created_at))} />
                <Field
                  label="Cancelled"
                  value={booking.cancelled_at ? dt.format(new Date(String(booking.cancelled_at))) : '—'}
                />
              </dl>
            </section>

            {(canCancel || canAssign) && (
              <section className="grid gap-4 lg:grid-cols-2">
                {canAssign && (
                  <AssignPanel
                    bookingId={id}
                    currentProfessionalId={booking.professional_id ?? null}
                    disabled={!['paid', 'searching', 'assigned'].includes(booking.status)}
                    onDone={load}
                  />
                )}
                {canCancel && (
                  <CancelPanel
                    bookingId={id}
                    disabled={['cancelled', 'completed', 'refunded', 'closed'].includes(booking.status)}
                    onDone={load}
                  />
                )}
              </section>
            )}

            <section className="rounded-2xl bg-white p-6 shadow-xl">
              <h2 className="text-base font-semibold text-gray-900">Items</h2>
              <ul className="mt-3 divide-y divide-gray-100">
                {detail.items.map((item) => (
                  <li key={item.id} className="flex items-center justify-between py-2 text-sm">
                    <span className="text-gray-900">
                      {item.service_name} × {item.quantity}
                    </span>
                    <span className="tabular-nums text-gray-700">{money(item.line_total)}</span>
                  </li>
                ))}
                {detail.items.length === 0 && <li className="py-2 text-sm text-gray-500">No items.</li>}
              </ul>
            </section>

            <section className="rounded-2xl bg-white p-6 shadow-xl">
              <h2 className="text-base font-semibold text-gray-900">Status history</h2>
              <ol className="mt-3 space-y-2">
                {detail.history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                    <span className="text-gray-500">{dt.format(new Date(h.created_at))}</span>
                    <span className="font-medium text-gray-900">
                      {h.from_status ? `${h.from_status} → ${h.to_status}` : h.to_status}
                    </span>
                    {h.actor_role && <span className="text-xs text-gray-500">by {h.actor_role}</span>}
                    {h.note && <span className="text-xs text-gray-500">“{h.note}”</span>}
                  </li>
                ))}
                {detail.history.length === 0 && <li className="text-sm text-gray-500">No history.</li>}
              </ol>
            </section>

            <section className="rounded-2xl bg-white p-6 shadow-xl">
              <h2 className="text-base font-semibold text-gray-900">Offers</h2>
              <ul className="mt-3 divide-y divide-gray-100">
                {detail.assignments.map((a) => (
                  <li key={a.id} className="flex items-center justify-between py-2 text-sm">
                    <span className="text-gray-700">{a.professional_id.slice(0, 8)}…</span>
                    <StatusPill status={a.status} />
                    <span className="text-gray-500">{dt.format(new Date(a.offered_at))}</span>
                  </li>
                ))}
                {detail.assignments.length === 0 && <li className="py-2 text-sm text-gray-500">No offers yet.</li>}
              </ul>
            </section>

            <section className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl bg-white p-6 shadow-xl">
                <h2 className="text-base font-semibold text-gray-900">Payments</h2>
                <ul className="mt-3 divide-y divide-gray-100">
                  {detail.payments.map((p) => (
                    <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                      <span className="text-gray-700">{p.method ?? 'payment'}</span>
                      <StatusPill status={p.status} />
                      <span className="tabular-nums text-gray-700">{money(p.amount)}</span>
                    </li>
                  ))}
                  {detail.payments.length === 0 && <li className="py-2 text-sm text-gray-500">No payments.</li>}
                </ul>
              </div>
              <div className="rounded-2xl bg-white p-6 shadow-xl">
                <h2 className="text-base font-semibold text-gray-900">Refunds</h2>
                <ul className="mt-3 divide-y divide-gray-100">
                  {detail.refunds.map((r) => (
                    <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                      <span className="text-gray-700">{r.reason_code}</span>
                      <StatusPill status={r.status} />
                      <span className="tabular-nums text-gray-700">{money(r.amount)}</span>
                    </li>
                  ))}
                  {detail.refunds.length === 0 && <li className="py-2 text-sm text-gray-500">No refunds.</li>}
                </ul>
              </div>
            </section>
          </div>
        )}
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

function AssignPanel({
  bookingId,
  currentProfessionalId,
  disabled,
  onDone,
}: {
  bookingId: string;
  currentProfessionalId: string | null;
  disabled: boolean;
  onDone: () => void;
}) {
  const [pros, setPros] = useState<AdminProfessionalListItem[]>([]);
  const [selected, setSelected] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetchAdminProfessionals({ verificationStatus: 'verified', limit: 100 })
      .then((res) => setPros(res.professionals))
      .catch(() => setPros([]));
  }, []);

  async function submit() {
    if (!selected) return;
    setBusy(true);
    setMessage(null);
    try {
      await assignAdminBooking(bookingId, { professionalId: selected, note: note || null });
      setMessage({ tone: 'ok', text: 'Offer raised. The professional can now accept it.' });
      setNote('');
      onDone();
    } catch (e) {
      const text = e instanceof AdminApiError ? e.message : 'Could not assign.';
      setMessage({ tone: 'error', text });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl bg-white p-6 shadow-xl">
      <h2 className="text-base font-semibold text-gray-900">Assign a professional</h2>
      <p className="mt-1 text-sm text-gray-600">
        Raises an ordinary offer the professional still accepts. Only a verified professional can be chosen.
      </p>

      <label className="mt-4 flex flex-col gap-1 text-sm">
        <span className="font-medium text-gray-700">Professional</span>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={disabled || busy}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50"
        >
          <option value="">Choose a professional…</option>
          {pros.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name ?? p.id.slice(0, 8)}
              {p.id === currentProfessionalId ? ' (current)' : ''}
            </option>
          ))}
        </select>
      </label>

      <label className="mt-3 flex flex-col gap-1 text-sm">
        <span className="font-medium text-gray-700">Note (optional)</span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          disabled={disabled || busy}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50"
        />
      </label>

      <button
        type="button"
        onClick={submit}
        disabled={disabled || busy || !selected}
        className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? 'Assigning…' : 'Assign'}
      </button>

      {disabled && <p className="mt-3 text-xs text-gray-500">This booking is past the point of reassignment.</p>}
      {message && (
        <p className={`mt-3 text-sm ${message.tone === 'ok' ? 'text-green-700' : 'text-red-700'}`} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}

function CancelPanel({
  bookingId,
  disabled,
  onDone,
}: {
  bookingId: string;
  disabled: boolean;
  onDone: () => void;
}) {
  const [reasonCode, setReasonCode] = useState('ops_cancelled');
  const [note, setNote] = useState('');
  const [chargeCustomer, setChargeCustomer] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await cancelAdminBooking(bookingId, {
        reasonCode,
        note: note || null,
        chargeCustomer,
      });
      setMessage({
        tone: 'ok',
        text: res.waived
          ? 'Booking cancelled. No fee charged (§11.2 waiver).'
          : `Booking cancelled. Fee ${inr.format(res.fee)}.`,
      });
      setConfirming(false);
      onDone();
    } catch (e) {
      const text = e instanceof AdminApiError ? e.message : 'Could not cancel.';
      setMessage({ tone: 'error', text });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl bg-white p-6 shadow-xl">
      <h2 className="text-base font-semibold text-gray-900">Cancel this booking</h2>
      <p className="mt-1 text-sm text-gray-600">
        Withdraws the professional holding it and releases their calendar. A cancellation that is not the customer’s
        fault waives the §11.1 fee.
      </p>

      <label className="mt-4 flex flex-col gap-1 text-sm">
        <span className="font-medium text-gray-700">Reason code</span>
        <input
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value)}
          disabled={disabled || busy}
          maxLength={60}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50"
        />
      </label>

      <label className="mt-3 flex flex-col gap-1 text-sm">
        <span className="font-medium text-gray-700">Note (optional)</span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={disabled || busy}
          maxLength={500}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50"
        />
      </label>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={chargeCustomer}
          onChange={(e) => setChargeCustomer(e.target.checked)}
          disabled={disabled || busy}
          className="h-4 w-4 rounded border-gray-300 text-blue-600"
        />
        <span className="text-gray-700">Apply the §11.1 fee (customer-caused)</span>
      </label>

      {confirming ? (
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? 'Cancelling…' : 'Confirm cancellation'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="text-sm font-medium text-gray-600 hover:text-gray-900"
          >
            Back
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={disabled || busy}
          className="mt-4 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          Cancel booking
        </button>
      )}

      {disabled && <p className="mt-3 text-xs text-gray-500">This booking is already in a terminal state.</p>}
      {message && (
        <p className={`mt-3 text-sm ${message.tone === 'ok' ? 'text-green-700' : 'text-red-700'}`} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
