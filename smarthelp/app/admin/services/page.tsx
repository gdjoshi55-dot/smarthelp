'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import DataTable, { type Column } from '@/components/admin/DataTable';
import { useAuth } from '@/contexts/AuthContext';
import { createService, fetchAdminServices, type AdminServiceListItem, type AdminServicePayload } from '@/lib/adminClient';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];
const PAGE_SIZE = 25;
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });

interface ServiceForm {
  categoryId: string;
  name: string;
  shortDescription: string;
  basePrice: string;
  pricingType: 'hourly' | 'flat' | 'per_unit';
  unitLabel: string;
  unitPrice: string;
  minDurationMin: string;
  maxDurationMin: string;
  prepMinutes: string;
  maxActiveJobs: string;
  materialsIncluded: boolean;
  materialsNote: string;
  requiresPhotoProof: boolean;
  sortOrder: string;
  isActive: boolean;
}

const emptyForm = (): ServiceForm => ({
  categoryId: '',
  name: '',
  shortDescription: '',
  basePrice: '999',
  pricingType: 'hourly',
  unitLabel: '',
  unitPrice: '',
  minDurationMin: '60',
  maxDurationMin: '480',
  prepMinutes: '15',
  maxActiveJobs: '3',
  materialsIncluded: false,
  materialsNote: '',
  requiresPhotoProof: false,
  sortOrder: '0',
  isActive: true,
});

/**
 * The catalogue editor (§7, §24, §31.1). Staff read; `service.manage` creates.
 * Durations and service areas live on the service's detail page.
 */
export default function AdminServices() {
  const { roleLabel, hasCapability } = useAuth();
  const canManage = hasCapability('service.manage');

  const [q, setQ] = useState('');
  const [active, setActive] = useState('');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AdminServiceListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [form, setForm] = useState<ServiceForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [flashed, setFlashed] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    fetchAdminServices({
      q: q || undefined,
      isActive: active === '' ? undefined : active === 'true',
      limit: PAGE_SIZE,
      offset,
    })
      .then((res) => {
        setRows(res.services);
        setTotal(res.total);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [q, active, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setFormError(null);
    try {
      const payload: AdminServicePayload = {
        categoryId: form.categoryId,
        name: form.name,
        shortDescription: form.shortDescription || null,
        basePrice: Number(form.basePrice),
        pricingType: form.pricingType,
        unitLabel: form.pricingType === 'per_unit' ? form.unitLabel || null : null,
        unitPrice: form.pricingType === 'per_unit' && form.unitPrice !== '' ? Number(form.unitPrice) : null,
        minDurationMin: Number(form.minDurationMin || 30),
        maxDurationMin: Number(form.maxDurationMin || 480),
        prepMinutes: Number(form.prepMinutes || 0),
        maxActiveJobs: Number(form.maxActiveJobs || 1),
        materialsIncluded: form.materialsIncluded,
        materialsNote: form.materialsNote || null,
        requiresPhotoProof: form.requiresPhotoProof,
        sortOrder: Number(form.sortOrder || 0),
        isActive: form.isActive,
      };
      const { service } = await createService(payload);
      setForm(null);
      setFlashed(`Created “${service.service.name}”. Add its durations and areas.`);
      setTimeout(() => setFlashed(null), 6000);
      load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'The service could not be created.');
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<AdminServiceListItem>[] = [
    {
      key: 'name',
      header: 'Service',
      render: (r) => (
        <Link href={`/admin/services/${r.id}`} className="font-medium text-blue-700 hover:underline">
          {r.name}
        </Link>
      ),
    },
    { key: 'category', header: 'Category', render: (r) => r.categoryName },
    { key: 'pricing', header: 'Pricing', render: (r) => r.pricingType },
    { key: 'price', header: 'Base price', className: 'text-right', render: (r) => money.format(r.basePrice) },
    { key: 'duration', header: 'Min duration', className: 'text-right', render: (r) => `${r.durationMin} min` },
    { key: 'active', header: 'Active', render: (r) => (r.isActive ? 'Yes' : 'No') },
  ];

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell role="admin" eyebrow={roleLabel ?? 'Operations'} title="Services">
        <div className="space-y-4">
          {!canManage && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              You can review the catalogue here, but only an admin can change it.
            </p>
          )}
          {flashed && <p className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{flashed}</p>}

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">Active</span>
              <select
                value={active}
                onChange={(e) => {
                  setActive(e.target.value);
                  setOffset(0);
                }}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All</option>
                <option value="true">Active only</option>
                <option value="false">Inactive only</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">Search</span>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-full min-w-48 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              />
            </label>
            {canManage && !form && (
              <button
                type="button"
                onClick={() => {
                  setForm(emptyForm());
                  setFormError(null);
                }}
                className="ml-auto rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                New service
              </button>
            )}
          </div>

          {form && (
            <ServiceEditor form={form} setForm={setForm} busy={busy} error={formError} onCancel={() => setForm(null)} onSave={save} />
          )}

          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
              We could not load the catalogue. Try again.
            </div>
          ) : (
            <>
              <DataTable
                columns={columns}
                rows={rows}
                keyOf={(r) => r.id}
                caption="Service catalogue"
                empty={loading ? 'Loading…' : 'No services match these filters.'}
              />
              <div className="flex items-center justify-between text-sm text-gray-600">
                <span>
                  {total} service{total === 1 ? '' : 's'} · page {page} of {pages}
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

function ServiceEditor({
  form,
  setForm,
  busy,
  error,
  onCancel,
  onSave,
}: {
  form: ServiceForm;
  setForm: (f: ServiceForm) => void;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = (patch: Partial<ServiceForm>) => setForm({ ...form, ...patch });
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
        <TextField label="Category ID" value={form.categoryId} onChange={(v) => set({ categoryId: v })} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-gray-700">Pricing type</span>
          <select value={form.pricingType} onChange={(e) => set({ pricingType: e.target.value as ServiceForm['pricingType'] })} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
            <option value="hourly">hourly</option>
            <option value="flat">flat</option>
            <option value="per_unit">per_unit</option>
          </select>
        </label>
        <TextField label="Base price (₹)" value={form.basePrice} onChange={(v) => set({ basePrice: v })} />
        {form.pricingType === 'per_unit' && (
          <>
            <TextField label="Unit label" value={form.unitLabel} onChange={(v) => set({ unitLabel: v })} />
            <TextField label="Unit price (₹)" value={form.unitPrice} onChange={(v) => set({ unitPrice: v })} />
          </>
        )}
        <TextField label="Min duration (min)" value={form.minDurationMin} onChange={(v) => set({ minDurationMin: v })} />
        <TextField label="Max duration (min)" value={form.maxDurationMin} onChange={(v) => set({ maxDurationMin: v })} />
        <TextField label="Prep minutes" value={form.prepMinutes} onChange={(v) => set({ prepMinutes: v })} />
        <TextField label="Max active jobs" value={form.maxActiveJobs} onChange={(v) => set({ maxActiveJobs: v })} />
        <TextField label="Sort order" value={form.sortOrder} onChange={(v) => set({ sortOrder: v })} />
        <TextField label="Short description" value={form.shortDescription} onChange={(v) => set({ shortDescription: v })} />
        <TextField label="Materials note" value={form.materialsNote} onChange={(v) => set({ materialsNote: v })} />
      </div>

      <div className="flex flex-wrap gap-4 text-sm font-medium text-gray-700">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.materialsIncluded} onChange={(e) => set({ materialsIncluded: e.target.checked })} />
          Materials included
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.requiresPhotoProof} onChange={(e) => set({ requiresPhotoProof: e.target.checked })} />
          Requires photo proof
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
          Active
        </label>
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          Create service
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
      <input value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" />
    </label>
  );
}