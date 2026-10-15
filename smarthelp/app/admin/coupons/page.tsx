'use client';

import { useCallback, useEffect, useState } from 'react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import DataTable, { type Column } from '@/components/admin/DataTable';
import { useAuth } from '@/contexts/AuthContext';
import {
  createCoupon,
  fetchAdminCoupon,
  fetchAdminCoupons,
  updateCoupon,
  type AdminCouponListItem,
  type AdminCouponPayload,
} from '@/lib/adminClient';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];
const PAGE_SIZE = 25;
const dt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' });
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });

interface CouponForm {
  id: string | null;
  code: string;
  description: string;
  discountType: 'percentage' | 'fixed';
  discountValue: string;
  maxDiscount: string;
  minBookingAmount: string;
  maxDiscountPctOfTotal: string;
  validFrom: string;
  validTo: string;
  usageLimit: string;
  perUserLimit: string;
  applicableCities: string;
  applicableServices: string[];
  firstTimeOnly: boolean;
  isActive: boolean;
}

const emptyForm = (): CouponForm => ({
  id: null,
  code: '',
  description: '',
  discountType: 'percentage',
  discountValue: '10',
  maxDiscount: '',
  minBookingAmount: '0',
  maxDiscountPctOfTotal: '100',
  validFrom: new Date().toISOString().slice(0, 16),
  validTo: '',
  usageLimit: '',
  perUserLimit: '1',
  applicableCities: '',
  applicableServices: [],
  firstTimeOnly: false,
  isActive: true,
});

const toInstant = (v: string): string | null => (v ? new Date(v).toISOString() : null);

/**
 * The promo-code console (§9, §24, §31.1). Staff read; `coupon.manage` writes.
 * The editor preserves a coupon's existing service scoping, which the list does
 * not carry, by loading the detail before it edits.
 */
export default function AdminCoupons() {
  const { roleLabel, hasCapability } = useAuth();
  const canManage = hasCapability('coupon.manage');

  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AdminCouponListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [form, setForm] = useState<CouponForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [flashed, setFlashed] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    fetchAdminCoupons({ q: q || undefined, status: status || undefined, limit: PAGE_SIZE, offset })
      .then((res) => {
        setRows(res.coupons);
        setTotal(res.total);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [q, status, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const openEdit = async (id: string) => {
    setFormError(null);
    try {
      const { coupon } = await fetchAdminCoupon(id);
      setForm({
        id: coupon.id,
        code: coupon.code,
        description: coupon.description ?? '',
        discountType: coupon.discountType as CouponForm['discountType'],
        discountValue: String(coupon.discountValue),
        maxDiscount: coupon.maxDiscount === null ? '' : String(coupon.maxDiscount),
        minBookingAmount: String(coupon.minBookingAmount),
        maxDiscountPctOfTotal: String(coupon.maxDiscountPctOfTotal),
        validFrom: coupon.validFrom.slice(0, 16),
        validTo: coupon.validTo ? coupon.validTo.slice(0, 16) : '',
        usageLimit: coupon.usageLimit === null ? '' : String(coupon.usageLimit),
        perUserLimit: String(coupon.perUserLimit),
        applicableCities: coupon.applicableCities.join(', '),
        applicableServices: coupon.applicableServices,
        firstTimeOnly: coupon.firstTimeOnly,
        isActive: coupon.isActive,
      });
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'The coupon could not be opened.');
    }
  };

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setFormError(null);
    try {
      const payload: AdminCouponPayload = {
        code: form.code,
        description: form.description || null,
        discountType: form.discountType,
        discountValue: Number(form.discountValue),
        maxDiscount: form.maxDiscount === '' ? null : Number(form.maxDiscount),
        minBookingAmount: Number(form.minBookingAmount || 0),
        maxDiscountPctOfTotal: Number(form.maxDiscountPctOfTotal || 0),
        validFrom: toInstant(form.validFrom) ?? '',
        validTo: toInstant(form.validTo),
        usageLimit: form.usageLimit === '' ? null : Number(form.usageLimit),
        perUserLimit: Number(form.perUserLimit || 1),
        applicableCities: form.applicableCities
          ? form.applicableCities.split(',').map((s) => s.trim()).filter(Boolean)
          : [],
        applicableServices: form.applicableServices,
        firstTimeOnly: form.firstTimeOnly,
        isActive: form.isActive,
      };
      if (form.id) {
        await updateCoupon(form.id, payload);
        setFlashed('Coupon updated.');
      } else {
        await createCoupon(payload);
        setFlashed('Coupon created.');
      }
      setForm(null);
      setTimeout(() => setFlashed(null), 4000);
      load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'The coupon could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<AdminCouponListItem>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-mono font-medium text-gray-900">{r.code}</span> },
    { key: 'description', header: 'Description', render: (r) => r.description ?? '—' },
    {
      key: 'discount',
      header: 'Discount',
      render: (r) => (r.discountType === 'percentage' ? `${r.discountValue}%` : money.format(r.discountValue)),
    },
    { key: 'min', header: 'Min spend', className: 'text-right', render: (r) => money.format(r.minBookingAmount) },
    {
      key: 'window',
      header: 'Valid',
      render: (r) => `${dt.format(new Date(r.validFrom))} → ${r.validTo ? dt.format(new Date(r.validTo)) : '∞'}`,
    },
    {
      key: 'usage',
      header: 'Used',
      className: 'text-right',
      render: (r) => `${r.usageCount}${r.usageLimit ? ` / ${r.usageLimit}` : ''}`,
    },
    { key: 'active', header: 'Active', render: (r) => (r.isActive ? 'Yes' : 'No') },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            render: (r: AdminCouponListItem) => (
              <button type="button" onClick={() => openEdit(r.id)} className="text-sm font-medium text-blue-700 hover:underline">
                Edit
              </button>
            ),
          },
        ]
      : []),
  ];

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell role="admin" eyebrow={roleLabel ?? 'Operations'} title="Promo codes">
        <div className="space-y-4">
          {!canManage && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              You can review promo codes here, but only an admin can change them.
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
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All</option>
                <option value="active">Active</option>
                <option value="expired">Expired</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">Code</span>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-full min-w-40 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
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
                New coupon
              </button>
            )}
          </div>

          {form && (
            <CouponEditor form={form} setForm={setForm} busy={busy} error={formError} onCancel={() => setForm(null)} onSave={save} />
          )}

          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
              We could not load the promo codes. Try again.
            </div>
          ) : (
            <>
              <DataTable
                columns={columns}
                rows={rows}
                keyOf={(r) => r.id}
                caption="Promo codes"
                empty={loading ? 'Loading…' : 'No promo codes match these filters.'}
              />
              <div className="flex items-center justify-between text-sm text-gray-600">
                <span>
                  {total} coupon{total === 1 ? '' : 's'} · page {page} of {pages}
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

function CouponEditor({
  form,
  setForm,
  busy,
  error,
  onCancel,
  onSave,
}: {
  form: CouponForm;
  setForm: (f: CouponForm) => void;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = (patch: Partial<CouponForm>) => setForm({ ...form, ...patch });
  return (
    <form
      className="space-y-3 rounded-2xl border border-blue-200 bg-blue-50/50 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <TextField label="Code" value={form.code} onChange={(v) => set({ code: v })} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-gray-700">Type</span>
          <select value={form.discountType} onChange={(e) => set({ discountType: e.target.value as CouponForm['discountType'] })} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
            <option value="percentage">percentage</option>
            <option value="fixed">fixed</option>
          </select>
        </label>
        <TextField label={form.discountType === 'percentage' ? 'Discount (%)' : 'Discount (₹)'} value={form.discountValue} onChange={(v) => set({ discountValue: v })} />
        <TextField label="Max discount (₹, optional)" value={form.maxDiscount} onChange={(v) => set({ maxDiscount: v })} />
        <TextField label="Min spend (₹)" value={form.minBookingAmount} onChange={(v) => set({ minBookingAmount: v })} />
        <TextField label="Max % of total" value={form.maxDiscountPctOfTotal} onChange={(v) => set({ maxDiscountPctOfTotal: v })} />
        <TextField label="Valid from" value={form.validFrom} onChange={(v) => set({ validFrom: v })} />
        <TextField label="Valid to (optional)" value={form.validTo} onChange={(v) => set({ validTo: v })} />
        <TextField label="Usage limit (optional)" value={form.usageLimit} onChange={(v) => set({ usageLimit: v })} />
        <TextField label="Per-user limit" value={form.perUserLimit} onChange={(v) => set({ perUserLimit: v })} />
        <TextField label="Pincodes (comma-separated)" value={form.applicableCities} onChange={(v) => set({ applicableCities: v })} />
        <TextField label="Description" value={form.description} onChange={(v) => set({ description: v })} />
      </div>

      <div className="flex flex-wrap gap-4 text-sm font-medium text-gray-700">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.firstTimeOnly} onChange={(e) => set({ firstTimeOnly: e.target.checked })} />
          First booking only
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
          Active
        </label>
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {form.id ? 'Save coupon' : 'Create coupon'}
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