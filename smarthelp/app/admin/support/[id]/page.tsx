'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import StatusPill from '@/components/admin/StatusPill';
import { useAuth } from '@/contexts/AuthContext';
import {
  addSupportMessage,
  fetchSupportTicket,
  updateSupportTicket,
  type AdminSupportTicketDetail,
  type SupportTicketPriority,
  type SupportTicketStatus,
} from '@/lib/adminClient';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];
const dt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * One support ticket (§24, §31.1). Staff read; `ticket.write` triages and
 * replies. Every write re-loads the detail, so the thread shows what the
 * database holds.
 */
export default function AdminSupportTicket() {
  const { roleLabel, hasCapability, profile } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const canWrite = hasCapability('ticket.write');

  const [detail, setDetail] = useState<AdminSupportTicketDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState<SupportTicketStatus>('open');
  const [priority, setPriority] = useState<SupportTicketPriority>('normal');
  const [resolution, setResolution] = useState('');

  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);

  const load = useCallback(() => {
    setLoadError(false);
    fetchSupportTicket(id)
      .then((d) => {
        setDetail(d);
        setStatus(d.ticket.status);
        setPriority(d.ticket.priority);
        setResolution(d.ticket.resolution ?? '');
      })
      .catch(() => setLoadError(true));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const saveTriage = async () => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const d = await updateSupportTicket(id, {
        status,
        priority,
        resolution: resolution || null,
      });
      setDetail(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The ticket could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  const assignToMe = async () => {
    if (!detail || !profile?.id) return;
    setBusy(true);
    setError(null);
    try {
      const d = await updateSupportTicket(id, { assignedTo: profile.id });
      setDetail(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The ticket could not be assigned.');
    } finally {
      setBusy(false);
    }
  };

  const sendReply = async () => {
    if (!detail || !reply.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addSupportMessage(id, { body: reply.trim(), isInternal: internal });
      setReply('');
      setInternal(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The message could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const ticket = detail?.ticket;

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell role="admin" eyebrow={roleLabel ?? 'Operations'} title={ticket ? ticket.subject : 'Ticket'}>
        <div className="space-y-6">
          <Link href="/admin/support" className="inline-block text-sm font-medium text-blue-700 hover:underline">
            ← Back to support
          </Link>

          {loadError ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
              We could not load this ticket.
            </div>
          ) : !detail || !ticket ? (
            <p className="text-sm text-gray-600">Loading…</p>
          ) : (
            <>
              <section className="rounded-2xl bg-white p-6 shadow-xl">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusPill status={ticket.status} />
                  <span className="text-sm capitalize text-gray-600">{ticket.priority} priority</span>
                  <span className="text-sm text-gray-500">{ticket.category}</span>
                  {ticket.bookingNumber && (
                    <Link href={`/admin/bookings/${ticket.bookingId}`} className="text-sm text-blue-700 hover:underline">
                      Booking {ticket.bookingNumber}
                    </Link>
                  )}
                </div>
                <dl className="mt-5 grid gap-4 sm:grid-cols-3">
                  <Field label="Raised by" value={ticket.raisedByName ?? '—'} />
                  <Field label="Assigned to" value={ticket.assignedToName ?? 'Unassigned'} />
                  <Field label="Opened" value={dt.format(new Date(ticket.createdAt))} />
                </dl>
              </section>

              <section className="space-y-4">
                <h2 className="text-base font-semibold text-gray-900">Conversation</h2>
                {detail.messages.length === 0 ? (
                  <p className="text-sm text-gray-600">No messages yet.</p>
                ) : (
                  <ul className="space-y-3">
                    {detail.messages.map((m) => (
                      <li
                        key={m.id}
                        className={`rounded-2xl border p-4 ${
                          m.isInternal ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-white'
                        }`}
                      >
                        <div className="flex items-center justify-between text-xs text-gray-500">
                          <span className="font-medium text-gray-700">
                            {m.authorName ?? 'Staff'}
                            {m.isInternal && ' · internal note'}
                          </span>
                          <span>{dt.format(new Date(m.createdAt))}</span>
                        </div>
                        <p className="mt-2 whitespace-pre-wrap text-sm text-gray-800">{m.body}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {canWrite ? (
                <section className="space-y-4 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                  <h2 className="text-base font-semibold text-gray-900">Triage</h2>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="font-medium text-gray-700">Status</span>
                      <select value={status} onChange={(e) => setStatus(e.target.value as SupportTicketStatus)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
                        {(['open', 'pending', 'resolved', 'closed'] as const).map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="font-medium text-gray-700">Priority</span>
                      <select value={priority} onChange={(e) => setPriority(e.target.value as SupportTicketPriority)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
                        {(['low', 'normal', 'high', 'urgent'] as const).map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-sm sm:col-span-2 lg:col-span-1">
                      <span className="font-medium text-gray-700">Resolution note</span>
                      <input value={resolution} onChange={(e) => setResolution(e.target.value)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" />
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <button type="button" disabled={busy} onClick={saveTriage} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                      Save ticket
                    </button>
                    {profile?.id && profile.id !== ticket.assignedToId && (
                      <button type="button" disabled={busy} onClick={assignToMe} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                        Assign to me
                      </button>
                    )}
                  </div>

                  <div className="border-t border-gray-100 pt-4">
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="font-medium text-gray-700">Add message</span>
                      <textarea
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        rows={3}
                        className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                      />
                    </label>
                    <div className="mt-2 flex items-center justify-between">
                      <label className="flex items-center gap-2 text-sm text-gray-700">
                        <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                        Internal note (staff only)
                      </label>
                      <button type="button" disabled={busy || !reply.trim()} onClick={sendReply} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                        Send
                      </button>
                    </div>
                  </div>

                  {error && <p className="text-sm text-red-700">{error}</p>}
                </section>
              ) : (
                <p className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
                  You can read this ticket but not change it.
                </p>
              )}
            </>
          )}
        </div>
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
