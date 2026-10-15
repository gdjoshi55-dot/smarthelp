'use client';

import { useCallback, useEffect, useState } from 'react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import DataTable, { type Column } from '@/components/admin/DataTable';
import { useAuth } from '@/contexts/AuthContext';
import {
  createCancellationPolicy,
  createPricingRule,
  deleteCancellationPolicy,
  deletePricingRule,
  fetchAdminServices,
  fetchCancellationPolicies,
  fetchPricingRules,
  updateCancellationPolicy,
  updatePricingRule,
  type CancellationPolicyRow,
  type PricingRuleRow,
} from '@/lib/adminClient';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SCOPES = ['global', 'category', 'service'] as const;
const FEE_TYPES = ['free', 'percentage', 'fixed'] as const;

const minuteToTime = (m: number | null) =>
  m === null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const timeToMinute = (t: string): number | null => {
  if (!t) return null;
  const [h, mm] = t.split(':').map(Number);
  return h * 60 + mm;
};
const toInstant = (v: string): string | null => (v ? new Date(v).toISOString() : null);

interface RuleForm {
  id: string | null;
  name: string;
  scope: 'global' | 'category' | 'service';
  categoryId: string;
  serviceId: string;
  multiplier: string;
  daysOfWeek: number[];
  start: string;
  end: string;
  priority: string;
  validFrom: string;
  validTo: string;
  isActive: boolean;
}
const emptyRule = (): RuleForm => ({
  id: null,
  name: '',
  scope: 'global',
  categoryId: '',
  serviceId: '',
  multiplier: '1.2',
  daysOfWeek: [],
  start: '',
  end: '',
  priority: '10',
  validFrom: '',
  validTo: '',
  isActive: true,
});

interface PolicyForm {
  id: string | null;
  band: string;
  hoursBefore: string;
  feeType: 'free' | 'percentage' | 'fixed';
  feeValue: string;
  appliesWhenArrived: boolean;
  sortOrder: string;
  serviceId: string;
  isActive: boolean;
}
const emptyPolicy = (): PolicyForm => ({
  id: null,
  band: '',
  hoursBefore: '',
  feeType: 'percentage',
  feeValue: '0',
  appliesWhenArrived: false,
  sortOrder: '0',
  serviceId: '',
  isActive: true,
});

/**
 * The pricing console (§7.1 surge windows + §11.1 cancellation ladder) — §24, §31.1.
 *
 * Both lists are staff-readable; `pricing.manage` gates every write. The editors
 * send the full validated form, matching the routes' whole-row replace.
 */
export default function AdminPricing() {
  const { roleLabel, hasCapability } = useAuth();
  const canManage = hasCapability('pricing.manage');

  const [rules, setRules] = useState<PricingRuleRow[]>([]);
  const [policies, setPolicies] = useState<CancellationPolicyRow[]>([]);
  const [serviceNames, setServiceNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [flashed, setFlashed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [rule, setRule] = useState<RuleForm | null>(null);
  const [policy, setPolicy] = useState<PolicyForm | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    Promise.all([fetchPricingRules(), fetchCancellationPolicies(), fetchAdminServices({ limit: 200 })])
      .then(([r, p, s]) => {
        setRules(r.rules);
        setPolicies(p.policies);
        const names: Record<string, string> = {};
        for (const svc of s.services) names[svc.id] = svc.name;
        setServiceNames(names);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const flash = (message: string) => {
    setFlashed(message);
    setTimeout(() => setFlashed(null), 4000);
  };

  const saveRule = async () => {
    if (!rule) return;
    setBusy(true);
    setFormError(null);
    try {
      const payload = {
        name: rule.name,
        scope: rule.scope,
        categoryId: rule.scope === 'category' ? rule.categoryId : null,
        serviceId: rule.scope === 'service' ? rule.serviceId : null,
        multiplier: Number(rule.multiplier),
        daysOfWeek: rule.daysOfWeek,
        startMinute: timeToMinute(rule.start),
        endMinute: timeToMinute(rule.end),
        priority: Number(rule.priority),
        validFrom: toInstant(rule.validFrom),
        validTo: toInstant(rule.validTo),
        isActive: rule.isActive,
      };
      if (rule.id) {
        await updatePricingRule(rule.id, payload);
        flash('Rule updated.');
      } else {
        await createPricingRule(payload);
        flash('Rule created.');
      }
      setRule(null);
      load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'The rule could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = async () => {
    if (!policy) return;
    setBusy(true);
    setFormError(null);
    try {
      const payload = {
        band: policy.band || null,
        hoursBefore: policy.hoursBefore === '' ? null : Number(policy.hoursBefore),
        feeType: policy.feeType,
        feeValue: policy.appliesWhenArrived || policy.feeType === 'free' ? 0 : Number(policy.feeValue),
        appliesWhenArrived: policy.appliesWhenArrived,
        sortOrder: Number(policy.sortOrder),
        serviceId: policy.serviceId || null,
        isActive: policy.isActive,
      };
      if (policy.id) {
        await updateCancellationPolicy(policy.id, payload);
        flash('Band updated.');
      } else {
        await createCancellationPolicy(payload);
        flash('Band created.');
      }
      setPolicy(null);
      load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'The band could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<PricingRuleRow>[] = [
    { key: 'name', header: 'Rule', render: (r) => <span className="font-medium text-gray-900">{r.name}</span> },
    {
      key: 'scope',
      header: 'Scope',
      render: (r) => (
        <span className="capitalize">
          {r.scope}
          {r.service_id ? ` · ${serviceNames[r.service_id] ?? r.service_id.slice(0, 8)}` : ''}
        </span>
      ),
    },
    { key: 'multiplier', header: 'Multiplier', className: 'text-right', render: (r) => <span className="tabular-nums">{r.multiplier}×</span> },
    {
      key: 'window',
      header: 'Window',
      render: (r) => (
        <span>
          {startWindow(r.days_of_week, r.start_minute, r.end_minute)}
        </span>
      ),
    },
    { key: 'priority', header: 'Priority', className: 'text-right', render: (r) => r.priority },
    { key: 'active', header: 'Active', render: (r) => (r.is_active ? 'Yes' : 'No') },
  ];

  const policyColumns: Column<CancellationPolicyRow>[] = [
    { key: 'band', header: 'Band', render: (p) => <span className="font-medium text-gray-900">{p.band ?? '—'}</span> },
    { key: 'hours', header: 'Ceiling (h)', render: (p) => (p.applies_when_arrived ? 'on arrival' : (p.hours_before ?? '∞')) },
    { key: 'fee', header: 'Fee', render: (p) => `${p.fee_type} ${p.fee_value}` },
    { key: 'sort', header: 'Order', className: 'text-right', render: (p) => p.sort_order },
    { key: 'active', header: 'Active', render: (p) => (p.is_active ? 'Yes' : 'No') },
  ];

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell role="admin" eyebrow={roleLabel ?? 'Operations'} title="Pricing">
        <div className="space-y-8">
          {!canManage && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              You can review pricing here, but only an admin can change it.
            </p>
          )}
          {flashed && <p className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{flashed}</p>}

          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
              We could not load the pricing policy. Try again.
            </div>
          ) : (
            <>
              {/* Surge windows */}
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold text-gray-900">Surge windows</h2>
                  {canManage && !rule && (
                    <button
                      type="button"
                      onClick={() => {
                        setRule(emptyRule());
                        setFormError(null);
                      }}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      Add rule
                    </button>
                  )}
                </div>

                {rule && (
                  <RuleEditor
                    form={rule}
                    setForm={setRule}
                    services={serviceNames}
                    busy={busy}
                    error={formError}
                    onCancel={() => setRule(null)}
                    onSave={saveRule}
                  />
                )}

                <DataTable
                  columns={canManage ? [...columns, ruleActions(setRule, setFormError, load)] : columns}
                  rows={rules}
                  keyOf={(r) => r.id}
                  caption="Surge pricing rules"
                  empty={loading ? 'Loading…' : 'No surge rules.'}
                />
              </section>

              {/* Cancellation ladder */}
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold text-gray-900">Cancellation ladder</h2>
                  {canManage && !policy && (
                    <button
                      type="button"
                      onClick={() => {
                        setPolicy(emptyPolicy());
                        setFormError(null);
                      }}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      Add band
                    </button>
                  )}
                </div>

                {policy && (
                  <PolicyEditor
                    form={policy}
                    setForm={setPolicy}
                    busy={busy}
                    error={formError}
                    onCancel={() => setPolicy(null)}
                    onSave={savePolicy}
                  />
                )}

                <DataTable
                  columns={
                    canManage
                      ? [
                          ...policyColumns,
                          {
                            key: 'actions',
                            header: '',
                            render: (p: CancellationPolicyRow) => (
                              <RowActions
                                onEdit={() =>
                                  setPolicy({
                                    id: p.id,
                                    band: p.band ?? '',
                                    hoursBefore: p.hours_before ?? '',
                                    feeType: p.fee_type as PolicyForm['feeType'],
                                    feeValue: p.fee_value,
                                    appliesWhenArrived: p.applies_when_arrived,
                                    sortOrder: String(p.sort_order),
                                    serviceId: p.service_id ?? '',
                                    isActive: p.is_active,
                                  })
                                }
                                onDelete={async () => {
                                  await deleteCancellationPolicy(p.id);
                                  load();
                                }}
                              />
                            ),
                          },
                        ]
                      : policyColumns
                  }
                  rows={policies}
                  keyOf={(p) => p.id}
                  caption="Cancellation fee ladder"
                  empty={loading ? 'Loading…' : 'No cancellation bands.'}
                />
              </section>
            </>
          )}
        </div>
      </RoleShell>
    </AuthGuard>
  );
}

function ruleActions(
  setRule: (r: RuleForm) => void,
  setFormError: (e: string | null) => void,
  load: () => void
): Column<PricingRuleRow> {
  return {
    key: 'actions',
    header: '',
    render: (r) => (
      <RowActions
        onEdit={() => {
          setFormError(null);
          setRule({
            id: r.id,
            name: r.name,
            scope: r.scope,
            categoryId: r.category_id ?? '',
            serviceId: r.service_id ?? '',
            multiplier: r.multiplier,
            daysOfWeek: r.days_of_week,
            start: minuteToTime(r.start_minute),
            end: minuteToTime(r.end_minute),
            priority: String(r.priority),
            validFrom: r.valid_from ? r.valid_from.slice(0, 16) : '',
            validTo: r.valid_to ? r.valid_to.slice(0, 16) : '',
            isActive: r.is_active,
          });
        }}
        onDelete={async () => {
          await deletePricingRule(r.id);
          load();
        }}
      />
    ),
  };
}

function RowActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex gap-3">
      <button type="button" onClick={onEdit} className="text-sm font-medium text-blue-700 hover:underline">
        Edit
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onDelete();
          } finally {
            setBusy(false);
          }
        }}
        className="text-sm font-medium text-red-700 hover:underline disabled:opacity-50"
      >
        Delete
      </button>
    </div>
  );
}

function startWindow(days: number[], start: number | null, end: number | null): string {
  const d = days.length === 0 ? 'Every day' : days.map((n) => DAYS[n]).join(', ');
  if (start === null || end === null) return d;
  return `${d} · ${minuteToTime(start)}–${minuteToTime(end)}`;
}

function RuleEditor({
  form,
  setForm,
  services,
  busy,
  error,
  onCancel,
  onSave,
}: {
  form: RuleForm;
  setForm: (f: RuleForm) => void;
  services: Record<string, string>;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = (patch: Partial<RuleForm>) => setForm({ ...form, ...patch });
  return (
    <form
      className="space-y-3 rounded-2xl border border-blue-200 bg-blue-50/50 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <TextField label="Name" value={form.name} onChange={(v) => set({ name: v })} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-gray-700">Scope</span>
          <select value={form.scope} onChange={(e) => set({ scope: e.target.value as RuleForm['scope'] })} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {form.scope === 'service' && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-gray-700">Service</span>
            <select value={form.serviceId} onChange={(e) => set({ serviceId: e.target.value })} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
              <option value="">Pick a service…</option>
              {Object.entries(services).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        {form.scope === 'category' && (
          <TextField label="Category ID" value={form.categoryId} onChange={(v) => set({ categoryId: v })} />
        )}
        <TextField label="Multiplier" value={form.multiplier} onChange={(v) => set({ multiplier: v })} />
        <TextField label="Priority" value={form.priority} onChange={(v) => set({ priority: v })} />
        <TextField label="Start (HH:MM)" value={form.start} onChange={(v) => set({ start: v })} />
        <TextField label="End (HH:MM)" value={form.end} onChange={(v) => set({ end: v })} />
        <TextField label="Valid from" value={form.validFrom} onChange={(v) => set({ validFrom: v })} />
        <TextField label="Valid to" value={form.validTo} onChange={(v) => set({ validTo: v })} />
      </div>

      <fieldset className="flex flex-wrap items-center gap-3 text-sm">
        <legend className="sr-only">Days of week</legend>
        {DAYS.map((label, n) => (
          <label key={n} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={form.daysOfWeek.includes(n)}
              onChange={(e) =>
                set({
                  daysOfWeek: e.target.checked
                    ? [...form.daysOfWeek, n].sort((a, b) => a - b)
                    : form.daysOfWeek.filter((d) => d !== n),
                })
              }
            />
            {label}
          </label>
        ))}
      </fieldset>

      <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
        <input type="checkbox" checked={form.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
        Active
      </label>

      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {form.id ? 'Save rule' : 'Create rule'}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </form>
  );
}

function PolicyEditor({
  form,
  setForm,
  busy,
  error,
  onCancel,
  onSave,
}: {
  form: PolicyForm;
  setForm: (f: PolicyForm) => void;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = (patch: Partial<PolicyForm>) => setForm({ ...form, ...patch });
  return (
    <form
      className="space-y-3 rounded-2xl border border-blue-200 bg-blue-50/50 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <TextField label="Band" value={form.band} onChange={(v) => set({ band: v })} />
        <TextField label="Hours before (ceiling)" value={form.hoursBefore} onChange={(v) => set({ hoursBefore: v })} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-gray-700">Fee type</span>
          <select value={form.feeType} onChange={(e) => set({ feeType: e.target.value as PolicyForm['feeType'] })} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
            {FEE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <TextField label="Fee value" value={form.feeValue} onChange={(v) => set({ feeValue: v })} />
        <TextField label="Sort order" value={form.sortOrder} onChange={(v) => set({ sortOrder: v })} />
        <TextField label="Service ID (optional)" value={form.serviceId} onChange={(v) => set({ serviceId: v })} />
      </div>

      <div className="flex flex-wrap gap-4 text-sm font-medium text-gray-700">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.appliesWhenArrived} onChange={(e) => set({ appliesWhenArrived: e.target.checked })} />
          Applies on arrival
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
          Active
        </label>
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {form.id ? 'Save band' : 'Create band'}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </form>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-gray-700">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
      />
    </label>
  );
}