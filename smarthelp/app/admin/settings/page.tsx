'use client';

import { useCallback, useEffect, useState } from 'react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import { useAuth } from '@/contexts/AuthContext';
import { fetchPlatformSettings, updatePlatformSettings, type PlatformSettings } from '@/lib/adminClient';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

/** Every setting, with a human label. The order is the order the form renders. */
const FIELDS: { key: keyof PlatformSettings; label: string; hint?: string }[] = [
  { key: 'currency', label: 'Currency' },
  { key: 'taxRate', label: 'Tax rate (%)' },
  { key: 'commissionPct', label: 'Commission (%)' },
  { key: 'platformFeePct', label: 'Platform fee (%)' },
  { key: 'platformFeeMin', label: 'Platform fee minimum (₹)' },
  { key: 'supportRefundLimit', label: 'Support refund limit (₹)', hint: 'Refunds above this need a second approver.' },
  { key: 'serviceOtpLength', label: 'Service OTP length' },
  { key: 'instantLeadMinutes', label: 'Instant lead time (min)' },
  { key: 'maxBookingMinutes', label: 'Max booking length (min)' },
  { key: 'maxSchedulingDaysAhead', label: 'Max scheduling days ahead' },
  { key: 'instantMatchTargetSeconds', label: 'Instant match target (s)' },
  { key: 'lateArrivalThresholdMin', label: 'Late arrival threshold (min)' },
  { key: 'noShowAfterMin', label: 'No-show after (min)' },
  { key: 'offerTtlMinutes', label: 'Offer TTL (min)' },
  { key: 'searchWindowMinutes', label: 'Search window (min)' },
  { key: 'otpTtlMinutes', label: 'OTP TTL (min)' },
  { key: 'otpMaxAttempts', label: 'OTP max attempts' },
  { key: 'otpLockoutMinutes', label: 'OTP lockout (min)' },
  { key: 'otpMaxGenerations', label: 'OTP max generations' },
  { key: 'defaultArrivalRadiusM', label: 'Default arrival radius (m)' },
  { key: 'proLocationFreshMinutes', label: 'Pro location freshness (min)' },
  { key: 'proLocationThrottleSeconds', label: 'Pro location throttle (s)' },
];

/**
 * The settings editor (§24.14, §31.1, D2). Any staff member reads it; only an
 * admin (`role.manage`) may save. Values are edited as text and converted on
 * save, so a number field never silently becomes a string.
 */
export default function AdminSettings() {
  const { roleLabel, hasCapability } = useAuth();
  const canManage = hasCapability('role.manage');

  const [saved, setSaved] = useState<PlatformSettings | null>(null);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flashed, setFlashed] = useState<string | null>(null);

  const toDraft = (s: PlatformSettings) =>
    Object.fromEntries(FIELDS.map((f) => [f.key, String(s[f.key])]));

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    fetchPlatformSettings()
      .then(({ settings }) => {
        setSaved(settings);
        setDraft(toDraft(settings));
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!draft || !saved) return;
    setBusy(true);
    setError(null);
    try {
      const patch: Partial<PlatformSettings> = {};
      for (const f of FIELDS) {
        const raw = draft[f.key];
        if (typeof saved[f.key] === 'number') {
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) {
            setError(`${f.label} must be a number that is zero or more.`);
            setBusy(false);
            return;
          }
          (patch as Record<string, unknown>)[f.key] = n;
        } else {
          (patch as Record<string, unknown>)[f.key] = raw;
        }
      }
      const { settings } = await updatePlatformSettings(patch);
      setSaved(settings);
      setDraft(toDraft(settings));
      setFlashed('Settings saved.');
      setTimeout(() => setFlashed(null), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The settings could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const dirty = draft && saved ? FIELDS.some((f) => draft[f.key] !== String(saved[f.key])) : false;

  return (
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell role="admin" eyebrow={roleLabel ?? 'Operations'} title="Settings">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Platform-wide rules the app reads at runtime. A change here takes effect on the next request.
          </p>
          {!canManage && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              You can review the settings here, but only an admin can change them.
            </p>
          )}
          {flashed && <p className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{flashed}</p>}

          {loadError ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
              We could not load the settings. Try again.
            </div>
          ) : loading || !draft ? (
            <p className="text-sm text-gray-600">Loading…</p>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (canManage) save();
              }}
            >
              <div className="grid gap-4 rounded-2xl bg-white p-6 shadow-xl sm:grid-cols-2 lg:grid-cols-3">
                {FIELDS.map((f) => (
                  <label key={f.key} className="flex flex-col gap-1 text-sm">
                    <span className="font-medium text-gray-700">{f.label}</span>
                    <input
                      value={draft[f.key]}
                      disabled={!canManage}
                      onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                      className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-500"
                    />
                    {f.hint && <span className="text-xs text-gray-500">{f.hint}</span>}
                  </label>
                ))}
              </div>

              {error && <p className="text-sm text-red-700">{error}</p>}
              {canManage && (
                <div className="flex items-center gap-3">
                  <button
                    type="submit"
                    disabled={busy || !dirty}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    Save settings
                  </button>
                  {dirty && (
                    <button
                      type="button"
                      onClick={() => saved && setDraft(toDraft(saved))}
                      className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Reset
                    </button>
                  )}
                </div>
              )}
            </form>
          )}
        </div>
      </RoleShell>
    </AuthGuard>
  );
}
