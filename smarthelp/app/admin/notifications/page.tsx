'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import { useAuth } from '@/contexts/AuthContext';
import {
  fetchNotificationTemplates,
  updateNotificationTemplate,
  type NotificationTemplateRow,
} from '@/lib/notificationClient';
import type { NotificationChannel, UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];
const CHANNELS: NotificationChannel[] = ['push', 'sms', 'email', 'in_app', 'whatsapp'];

interface Draft {
  subject: string;
  body: string;
  variables: string;
  isActive: boolean;
}

const toDraft = (t: NotificationTemplateRow): Draft => ({
  subject: t.subject ?? '',
  body: t.body,
  variables: t.variables.join(', '),
  isActive: t.is_active,
});

/**
 * The message catalogue (§25.10, D6).
 *
 * Staff read it; `notification.manage` (admin) edits it, because a template is
 * what every customer in the product reads — the same class of change as a role
 * grant. `subject` only means anything for the email channel, so it is only
 * offered there rather than shown empty for push and SMS.
 *
 * Templates are stored per (code, channel, locale); this screen does not create
 * or delete them, only edits the copy, so the catalogue's shape stays the seed's.
 */
export default function AdminNotifications() {
  const { roleLabel, hasCapability } = useAuth();
  const canManage = hasCapability('notification.manage');

  const [templates, setTemplates] = useState<NotificationTemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [codeFilter, setCodeFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState<'' | NotificationChannel>('');
  const [localeFilter, setLocaleFilter] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flashed, setFlashed] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    fetchNotificationTemplates({
      code: codeFilter || undefined,
      channel: channelFilter || undefined,
      locale: localeFilter || undefined,
      isActive: activeOnly || undefined,
      limit: 200,
    })
      .then(({ templates: rows }) => {
        setTemplates(rows);
        setSelectedId((current) => current ?? rows[0]?.id ?? null);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, [codeFilter, channelFilter, localeFilter, activeOnly]);

  useEffect(() => {
    load();
  }, [load]);

  const selected = useMemo(
    () => templates.find((t) => t.id === selectedId) ?? null,
    [templates, selectedId]
  );

  useEffect(() => {
    setDraft(selected ? toDraft(selected) : null);
    setError(null);
  }, [selected]);

  const dirty =
    draft && selected
      ? draft.subject !== (selected.subject ?? '') ||
        draft.body !== selected.body ||
        draft.variables !== selected.variables.join(', ') ||
        draft.isActive !== selected.is_active
      : false;

  const save = async () => {
    if (!draft || !selected) return;
    setBusy(true);
    setError(null);
    try {
      const variables = draft.variables
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      const { template } = await updateNotificationTemplate(selected.id, {
        subject: selected.channel === 'email' ? draft.subject : null,
        body: draft.body,
        variables,
        isActive: draft.isActive,
      });
      setTemplates((rows) => rows.map((r) => (r.id === template.id ? template : r)));
      setFlashed(`Saved ${template.code} (${template.channel}).`);
      setTimeout(() => setFlashed(null), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The template could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell role="admin" eyebrow={roleLabel ?? 'Operations'} title="Notifications">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            The messages SmartHelp sends. Editing the copy here changes what the next dispatch renders —
            the tokens in braces are filled from the booking.
          </p>
          {!canManage && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              You can review the catalogue, but only an admin can change a template.
            </p>
          )}
          {flashed && <p className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{flashed}</p>}

          <div className="flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">Code</span>
              <input
                value={codeFilter}
                onChange={(e) => setCodeFilter(e.target.value)}
                placeholder="e.g. BOOKING_CONFIRMED"
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">Channel</span>
              <select
                value={channelFilter}
                onChange={(e) => setChannelFilter(e.target.value as '' | NotificationChannel)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All</option>
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">Locale</span>
              <input
                value={localeFilter}
                onChange={(e) => setLocaleFilter(e.target.value)}
                placeholder="en-IN"
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={activeOnly}
                onChange={(e) => setActiveOnly(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <span className="font-medium text-gray-700">Active only</span>
            </label>
          </div>

          {loadError ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
              We could not load the catalogue. Try again.
            </div>
          ) : loading && templates.length === 0 ? (
            <p className="text-sm text-gray-600">Loading…</p>
          ) : templates.length === 0 ? (
            <p className="rounded-xl bg-white p-5 text-sm text-gray-600 shadow">
              No templates match those filters.
            </p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
              <ul className="max-h-[32rem] overflow-y-auto rounded-xl bg-white shadow divide-y divide-gray-100">
                {templates.map((t) => {
                  const current = t.id === selectedId;
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(t.id)}
                        aria-current={current ? 'true' : undefined}
                        className={`flex w-full flex-col px-4 py-3 text-left hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${
                          current ? 'bg-blue-50' : ''
                        }`}
                      >
                        <span className="text-sm font-medium text-gray-900">{t.code}</span>
                        <span className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 font-medium">{t.channel}</span>
                          <span>{t.locale}</span>
                          {!t.is_active && (
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">inactive</span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {selected && draft ? (
                <form
                  className="space-y-4 rounded-xl bg-white p-5 shadow"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (canManage) void save();
                  }}
                >
                  <div>
                    <h2 className="text-base font-semibold text-gray-900">{selected.code}</h2>
                    <p className="text-xs text-gray-500">
                      {selected.channel} · {selected.locale}
                    </p>
                  </div>

                  {selected.channel === 'email' && (
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="font-medium text-gray-700">Subject</span>
                      <input
                        value={draft.subject}
                        disabled={!canManage}
                        onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                        className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-500"
                      />
                    </label>
                  )}

                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium text-gray-700">Body</span>
                    <textarea
                      value={draft.body}
                      disabled={!canManage}
                      rows={8}
                      maxLength={4000}
                      onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                      className="rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm disabled:bg-gray-50 disabled:text-gray-500"
                    />
                  </label>

                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium text-gray-700">Tokens</span>
                    <input
                      value={draft.variables}
                      disabled={!canManage}
                      onChange={(e) => setDraft({ ...draft, variables: e.target.value })}
                      placeholder="customer_name, booking_number"
                      className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-500"
                    />
                    <span className="text-xs text-gray-500">
                      Comma-separated token names the body may use, e.g. <code>{'{customer_name}'}</code>.
                    </span>
                  </label>

                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.isActive}
                      disabled={!canManage}
                      onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <span className="font-medium text-gray-700">Active</span>
                  </label>

                  {error && <p className="text-sm text-red-700">{error}</p>}
                  {canManage && (
                    <div className="flex items-center gap-3">
                      <button
                        type="submit"
                        disabled={busy || !dirty}
                        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        Save template
                      </button>
                      {dirty && (
                        <button
                          type="button"
                          onClick={() => setDraft(toDraft(selected))}
                          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  )}
                </form>
              ) : null}
            </div>
          )}
        </div>
      </RoleShell>
    </AuthGuard>
  );
}
