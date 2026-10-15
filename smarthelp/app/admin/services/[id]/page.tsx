'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import StatusPill from '@/components/admin/StatusPill';
import ConfirmationDialog from '@/components/ui/ConfirmationDialog';
import { useAuth } from '@/contexts/AuthContext';
import {
  createServiceArea,
  createServiceDuration,
  deleteServiceArea,
  deleteServiceDuration,
  fetchAdminService,
  fetchLocalities,
  updateService,
  updateServiceArea,
  updateServiceDuration,
  type AdminServiceDetail,
  type AdminServicePayload,
  type AdminServiceRow,
  type ServiceAreaRow,
  type ServiceDurationRow,
} from '@/lib/adminClient';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(v));

/**
 * One service's console (§7, §24, §31.1): the service fields, its duration
 * ladder and its service areas. `service.manage` gates every write; each write
 * re-loads the detail so the screen shows what the database holds, not what the
 * form hoped.
 */
export default function AdminServiceDetailPage() {
  const { roleLabel, hasCapability } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const canManage = hasCapability('service.manage');

  const [detail, setDetail] = useState<AdminServiceDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(false);
    fetchAdminService(id)
      .then((res) => setDetail(res.service))
      .catch(() => setLoadError(true));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const svc = detail?.service;

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell role="admin" eyebrow={roleLabel ?? 'Operations'} title={svc ? svc.name : 'Service'}>
        <div className="space-y-6">
          <Link href="/admin/services" className="inline-block text-sm font-medium text-blue-700 hover:underline">
            ← Back to services
          </Link>

          {loadError ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
              We could not load this service.
            </div>
          ) : !detail || !svc ? (
            <p className="text-sm text-gray-600">Loading…</p>
          ) : (
            <>
              <section className="rounded-2xl bg-white p-6 shadow-xl">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusPill status={svc.is_active ? 'completed' : 'closed'} />
                    <span className="text-sm text-gray-500">{detail.categoryName}</span>
                    <code className="text-xs text-gray-400">{svc.slug}</code>
                  </div>
                  {canManage && !editing && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(true);
                        setActionError(null);
                      }}
                      className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Edit service
                    </button>
                  )}
                </div>

                <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Pricing" value={str(svc.pricing_type)} />
                  <Field label="Base price" value={money.format(Number(svc.base_price))} />
                  <Field label="Duration" value={`${num(svc.min_duration_min)}–${num(svc.max_duration_min)} min`} />
                  <Field label="Max active jobs" value={str(svc.max_active_jobs)} />
                </dl>
              </section>

              {editing && canManage && (
                <ServiceEditForm
                  row={svc}
                  categoryId={svc.category_id}
                  busy={busy === 'service'}
                  error={actionError}
                  onCancel={() => setEditing(false)}
                  onSave={async (payload) => {
                    setBusy('service');
                    setActionError(null);
                    try {
                      const { service } = await updateService(id, payload);
                      setDetail(service);
                      setEditing(false);
                    } catch (e) {
                      setActionError(e instanceof Error ? e.message : 'The service could not be saved.');
                    } finally {
                      setBusy(null);
                    }
                  }}
                />
              )}

              <DurationsSection
                serviceId={id}
                durations={detail.durations}
                canManage={canManage}
                busy={busy}
                setBusy={setBusy}
                error={actionError}
                setError={setActionError}
                reload={load}
              />

              <AreasSection
                serviceId={id}
                areas={detail.areas}
                canManage={canManage}
                busy={busy}
                setBusy={setBusy}
                error={actionError}
                setError={setActionError}
                reload={load}
              />
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

function ServiceEditForm({
  row,
  categoryId,
  busy,
  error,
  onCancel,
  onSave,
}: {
  row: AdminServiceRow;
  categoryId: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (payload: AdminServicePayload) => void;
}) {
  const [name, setName] = useState(row.name);
  const [basePrice, setBasePrice] = useState(num(row.base_price));
  const [pricingType, setPricingType] = useState<'hourly' | 'flat' | 'per_unit'>(
    (row.pricing_type as 'hourly' | 'flat' | 'per_unit') ?? 'hourly'
  );
  const [unitLabel, setUnitLabel] = useState(str(row.unit_label));
  const [unitPrice, setUnitPrice] = useState(num(row.unit_price));
  const [minDurationMin, setMinDurationMin] = useState(num(row.min_duration_min));
  const [maxDurationMin, setMaxDurationMin] = useState(num(row.max_duration_min));
  const [maxActiveJobs, setMaxActiveJobs] = useState(num(row.max_active_jobs));
  const [isActive, setIsActive] = useState(row.is_active);

  return (
    <form
      className="space-y-3 rounded-2xl border border-blue-200 bg-blue-50/50 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          categoryId,
          name,
          basePrice: Number(basePrice),
          pricingType,
          unitLabel: pricingType === 'per_unit' ? unitLabel || null : null,
          unitPrice: pricingType === 'per_unit' && unitPrice !== '' ? Number(unitPrice) : null,
          minDurationMin: Number(minDurationMin || 30),
          maxDurationMin: Number(maxDurationMin || 480),
          maxActiveJobs: Number(maxActiveJobs || 1),
          isActive,
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field2 label="Name" value={name} onChange={setName} />
        <Field2 label="Base price (₹)" value={basePrice} onChange={setBasePrice} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-gray-700">Pricing type</span>
          <select value={pricingType} onChange={(e) => setPricingType(e.target.value as typeof pricingType)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
            <option value="hourly">hourly</option>
            <option value="flat">flat</option>
            <option value="per_unit">per_unit</option>
          </select>
        </label>
        {pricingType === 'per_unit' && (
          <>
            <Field2 label="Unit label" value={unitLabel} onChange={setUnitLabel} />
            <Field2 label="Unit price (₹)" value={unitPrice} onChange={setUnitPrice} />
          </>
        )}
        <Field2 label="Min duration (min)" value={minDurationMin} onChange={setMinDurationMin} />
        <Field2 label="Max duration (min)" value={maxDurationMin} onChange={setMaxDurationMin} />
        <Field2 label="Max active jobs" value={maxActiveJobs} onChange={setMaxActiveJobs} />
      </div>
      <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Active
      </label>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          Save service
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </form>
  );
}

function DurationsSection({
  serviceId,
  durations,
  canManage,
  busy,
  setBusy,
  error,
  setError,
  reload,
}: {
  serviceId: string;
  durations: ServiceDurationRow[];
  canManage: boolean;
  busy: string | null;
  setBusy: (v: string | null) => void;
  error: string | null;
  setError: (v: string | null) => void;
  reload: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [minutes, setMinutes] = useState('120');
  const [price, setPrice] = useState('');
  const [multiplier, setMultiplier] = useState('');
  const [removing, setRemoving] = useState<ServiceDurationRow | null>(null);

  const add = async () => {
    setBusy('duration-add');
    setError(null);
    try {
      await createServiceDuration(serviceId, {
        minutes: Number(minutes),
        price: price === '' ? null : Number(price),
        priceMultiplier: multiplier === '' ? null : Number(multiplier),
      });
      setAdding(false);
      setPrice('');
      setMultiplier('');
      setMinutes('120');
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The duration could not be added.');
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (d: ServiceDurationRow) => {
    setBusy(d.id);
    setError(null);
    try {
      await updateServiceDuration(serviceId, d.id, { isActive: !d.is_active });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The duration could not be updated.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Duration ladder</h2>
        {canManage && !adding && (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setError(null);
            }}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Add duration
          </button>
        )}
      </div>

      {adding && (
        <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-blue-200 bg-blue-50/50 p-4">
          <Field2 label="Minutes" value={minutes} onChange={setMinutes} />
          <Field2 label="Price (₹)" value={price} onChange={setPrice} />
          <Field2 label="or multiplier" value={multiplier} onChange={setMultiplier} />
          <button type="button" disabled={busy === 'duration-add'} onClick={add} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            Add
          </button>
          <button type="button" onClick={() => setAdding(false)} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Cancel
          </button>
        </div>
      )}

      {durations.length === 0 ? (
        <p className="text-sm text-gray-600">No durations — the service&apos;s own range applies.</p>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
          {durations.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <span className="font-medium text-gray-900">{d.minutes} min</span>
              <span className="tabular-nums text-gray-700">
                {d.price !== null ? money.format(Number(d.price)) : d.price_multiplier !== null ? `${d.price_multiplier}×` : '—'}
              </span>
              <span className="flex items-center gap-3">
                <StatusPill status={d.is_active ? 'completed' : 'closed'} />
                {canManage && (
                  <>
                    <button type="button" disabled={busy === d.id} onClick={() => toggle(d)} className="font-medium text-blue-700 hover:underline disabled:opacity-50">
                      {d.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button type="button" onClick={() => setRemoving(d)} className="font-medium text-red-700 hover:underline">
                      Delete
                    </button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-sm text-red-700">{error}</p>}

      <ConfirmationDialog
        isOpen={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          setBusy(removing.id);
          try {
            await deleteServiceDuration(serviceId, removing.id);
            setRemoving(null);
            reload();
          } catch (e) {
            setError(e instanceof Error ? e.message : 'The duration could not be deleted.');
          } finally {
            setBusy(null);
          }
        }}
        title="Delete this duration?"
        message="Any booking already quoted against it keeps its price; future quotes lose this rung."
        confirmText="Delete"
        type="danger"
        isLoading={busy === removing?.id}
      />
    </section>
  );
}

function AreasSection({
  serviceId,
  areas,
  canManage,
  busy,
  setBusy,
  error,
  setError,
  reload,
}: {
  serviceId: string;
  areas: ServiceAreaRow[];
  canManage: boolean;
  busy: string | null;
  setBusy: (v: string | null) => void;
  error: string | null;
  setError: (v: string | null) => void;
  reload: () => void;
}) {
  const [localities, setLocalities] = useState<{ id: string; name: string; city: string }[]>([]);
  const [adding, setAdding] = useState(false);
  const [localityId, setLocalityId] = useState('');
  const [lead, setLead] = useState('60');
  const [capacity, setCapacity] = useState('8');

  useEffect(() => {
    fetchLocalities()
      .then((res) => setLocalities(res.localities))
      .catch(() => undefined);
  }, []);

  const add = async () => {
    if (!localityId) {
      setError('Pick a locality first.');
      return;
    }
    setBusy('area-add');
    setError(null);
    try {
      await createServiceArea(serviceId, {
        localityId,
        leadMinutes: Number(lead || 0),
        slotCapacity: Number(capacity || 1),
      });
      setAdding(false);
      setLocalityId('');
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The service area could not be added.');
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (a: ServiceAreaRow) => {
    setBusy(a.id);
    setError(null);
    try {
      await updateServiceArea(serviceId, a.id, { isActive: !a.is_active });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The service area could not be updated.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (a: ServiceAreaRow) => {
    setBusy(a.id);
    setError(null);
    try {
      await deleteServiceArea(serviceId, a.id);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The service area could not be removed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Service areas</h2>
        {canManage && !adding && (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setError(null);
            }}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Add area
          </button>
        )}
      </div>

      {adding && (
        <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-blue-200 bg-blue-50/50 p-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-gray-700">Locality</span>
            <select value={localityId} onChange={(e) => setLocalityId(e.target.value)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
              <option value="">Pick a locality…</option>
              {localities.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.city ? `, ${l.city}` : ''}
                </option>
              ))}
            </select>
          </label>
          <Field2 label="Lead minutes" value={lead} onChange={setLead} />
          <Field2 label="Slot capacity" value={capacity} onChange={setCapacity} />
          <button type="button" disabled={busy === 'area-add'} onClick={add} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            Add
          </button>
          <button type="button" onClick={() => setAdding(false)} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Cancel
          </button>
        </div>
      )}

      {areas.length === 0 ? (
        <p className="text-sm text-gray-600">No areas — this service is not bookable anywhere yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
          {areas.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <span className="font-medium text-gray-900">{a.localityName}</span>
              <span className="text-gray-700">
                {a.lead_minutes} min lead · {a.slot_capacity} slots
              </span>
              <span className="flex items-center gap-3">
                <StatusPill status={a.is_active ? 'completed' : 'closed'} />
                {canManage && (
                  <>
                    <button type="button" disabled={busy === a.id} onClick={() => toggle(a)} className="font-medium text-blue-700 hover:underline disabled:opacity-50">
                      {a.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button type="button" disabled={busy === a.id} onClick={() => remove(a)} className="font-medium text-red-700 hover:underline disabled:opacity-50">
                      Remove
                    </button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-sm text-red-700">{error}</p>}
    </section>
  );
}

function Field2({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-gray-700">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" />
    </label>
  );
}