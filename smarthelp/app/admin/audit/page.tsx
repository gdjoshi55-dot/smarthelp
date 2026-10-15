'use client';

import { useCallback, useEffect, useState } from 'react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import DataTable, { type Column } from '@/components/admin/DataTable';
import { useAuth } from '@/contexts/AuthContext';
import { fetchAuditLogs, type AdminAuditLogItem } from '@/lib/adminClient';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];
const PAGE_SIZE = 50;
const dt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The audit viewer (§20, §24.13, §31.1). Gated by `audit.read` (admin only).
 * Filters are query parameters; a selected row's before/after/metadata are shown
 * as-is, because that is exactly what was recorded.
 */
export default function AdminAudit() {
  const { roleLabel, hasCapability } = useAuth();
  const canRead = hasCapability('audit.read');

  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);

  const [rows, setRows] = useState<AdminAuditLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<AdminAuditLogItem | null>(null);

  const load = useCallback(() => {
    if (!canRead) return;
    setLoading(true);
    setError(false);
    fetchAuditLogs({
      action: action || undefined,
      entityType: entityType || undefined,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
      limit: PAGE_SIZE,
      offset,
    })
      .then((res) => {
        setRows(res.logs);
        setTotal(res.total);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [canRead, action, entityType, from, to, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const columns: Column<AdminAuditLogItem>[] = [
    { key: 'time', header: 'When', render: (r) => dt.format(new Date(r.createdAt)) },
    { key: 'action', header: 'Action', render: (r) => <span className="font-mono text-xs text-gray-900">{r.action}</span> },
    { key: 'actor', header: 'Actor', render: (r) => r.actorName ?? r.actorRole ?? '—' },
    { key: 'entity', header: 'Entity', render: (r) => `${r.entityType}${r.entityId ? ` · ${r.entityId.slice(0, 8)}…` : ''}` },
    {
      key: 'view',
      header: '',
      render: (r) => (
        <button type="button" onClick={() => setSelected(r)} className="text-sm font-medium text-blue-700 hover:underline">
          View
        </button>
      ),
    },
  ];

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell role="admin" eyebrow={roleLabel ?? 'Operations'} title="Audit log">
        <div className="space-y-4">
          {!canRead ? (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              The audit log is restricted to admins.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Action contains" value={action} onChange={(v) => { setAction(v); setOffset(0); }} />
                <Field label="Entity type" value={entityType} onChange={(v) => { setEntityType(v); setOffset(0); }} />
                <Field label="From" value={from} onChange={(v) => { setFrom(v); setOffset(0); }} />
                <Field label="To" value={to} onChange={(v) => { setTo(v); setOffset(0); }} />
              </div>

              {error ? (
                <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
                  We could not load the audit log. Try again.
                </div>
              ) : (
                <>
                  <DataTable
                    columns={columns}
                    rows={rows}
                    keyOf={(r) => r.id}
                    caption="Audit log"
                    empty={loading ? 'Loading…' : 'No audit entries match these filters.'}
                  />
                  <div className="flex items-center justify-between text-sm text-gray-600">
                    <span>
                      {total} entr{total === 1 ? 'y' : 'ies'} · page {page} of {pages}
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

              {selected && (
                <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-sm text-gray-900">{selected.action}</p>
                      <p className="text-xs text-gray-500">
                        {dt.format(new Date(selected.createdAt))} · {selected.entityType}
                        {selected.requestId ? ` · req ${selected.requestId}` : ''}
                      </p>
                    </div>
                    <button type="button" onClick={() => setSelected(null)} className="text-sm font-medium text-gray-600 hover:underline">
                      Close
                    </button>
                  </div>
                  <div className="mt-4 grid gap-4 sm:grid-cols-3">
                    <JsonBlock title="Before" value={selected.before} />
                    <JsonBlock title="After" value={selected.after} />
                    <JsonBlock title="Metadata" value={selected.metadata} />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </RoleShell>
    </AuthGuard>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-gray-700">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" />
    </label>
  );
}

function JsonBlock({ title, value }: { title: string; value: Record<string, unknown> | null }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{title}</p>
      {value ? (
        <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-800">
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : (
        <p className="mt-1 text-sm text-gray-400">—</p>
      )}
    </div>
  );
}
