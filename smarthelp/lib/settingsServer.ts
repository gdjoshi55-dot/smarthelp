import { createServerClient } from './supabaseServer';
import { PLATFORM_DEFAULTS } from './constants';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase';

/**
 * The typed reader over `platform_settings` (§24.14, §22, D2).
 *
 * `platform_settings` is a key/value table of jsonb; this module is the only
 * place in the app that knows what the keys mean. Each key is named here with
 * its type, and a value that is missing, malformed or of the wrong type falls
 * back to `PLATFORM_DEFAULTS` — the constants in `lib/constants.ts` are the
 * initial state, and this reader is the rule.
 *
 * Two properties this file is built around:
 *
 *   A missing row is not an error. A brand-new database, or one that predates a
 *   key being added, still answers every setting; the default is the answer. A
 *   caller never has to know whether the row exists.
 *
 *   A read returns the same shape as `PLATFORM_DEFAULTS`. The interface below is
 *   derived from the key table, so a key cannot be added to one without the
 *   other, and `getPlatformSettings()` is assignable to `PlatformSettings`
 *   without a cast at any call site.
 *
 * The reader is server-only (`supabaseServer` bypasses RLS). The browser never
 * reads settings directly; a Route Handler projects the ones a screen needs.
 */

/**
 * Every setting, with the type it is parsed as.
 *
 * `number` here means "stored as a JSON number or a numeric string, returned as
 * a number". Everything a setting can be is one of these two shapes; a boolean
 * or a string list would be a third type and would get a third branch, not a
 * legacy one.
 */
export const PLATFORM_SETTING_KEYS = {
  currency: 'string',
  taxRate: 'number',
  commissionPct: 'number',
  platformFeePct: 'number',
  platformFeeMin: 'number',
  serviceOtpLength: 'number',
  instantLeadMinutes: 'number',
  maxBookingMinutes: 'number',
  maxSchedulingDaysAhead: 'number',
  instantMatchTargetSeconds: 'number',
  lateArrivalThresholdMin: 'number',
  noShowAfterMin: 'number',
  supportRefundLimit: 'number',
  offerTtlMinutes: 'number',
  searchWindowMinutes: 'number',
  otpTtlMinutes: 'number',
  otpMaxAttempts: 'number',
  otpLockoutMinutes: 'number',
  otpMaxGenerations: 'number',
  defaultArrivalRadiusM: 'number',
  proLocationFreshMinutes: 'number',
  proLocationThrottleSeconds: 'number',
} as const;

export type PlatformSettingKey = keyof typeof PLATFORM_SETTING_KEYS;

/** The value type of one setting, from its entry in the key table. */
export type PlatformSettingValue<K extends PlatformSettingKey> =
  (typeof PLATFORM_SETTING_KEYS)[K] extends 'number' ? number : string;

/** The whole settings object: every key, correctly typed. */
export type PlatformSettings = {
  [K in PlatformSettingKey]: PlatformSettingValue<K>;
};

/** The current platform-wide rules, defaults filled in. */
export const PLATFORM_SETTINGS_DEFAULTS: PlatformSettings = {
  ...PLATFORM_DEFAULTS,
};

function coerce(
  key: PlatformSettingKey,
  raw: unknown,
  fallback: string | number
): string | number {
  if (PLATFORM_SETTING_KEYS[key] === 'number') {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return fallback;
}

/**
 * All settings, resolved. One query; the defaults are the seed and the
 * row-count is small (one row per key), so there is nothing to page or cache.
 */
export async function getPlatformSettings(
  supabase: SupabaseClient<Database> = createServerClient()
): Promise<PlatformSettings> {
  const { data, error } = await supabase.from('platform_settings').select('key, value');
  if (error) throw error;

  const rows = (data ?? []) as { key: string; value: unknown }[];
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  const out = {} as PlatformSettings;
  const writable = out as Record<PlatformSettingKey, unknown>;
  for (const key of Object.keys(PLATFORM_SETTING_KEYS) as PlatformSettingKey[]) {
    const fallback = PLATFORM_SETTINGS_DEFAULTS[key];
    writable[key] = coerce(key, byKey.get(key), fallback);
  }
  return out;
}

/**
 * Writes one setting, returning the row's new value.
 *
 * `updatedBy` is the staff profile id; the Route Handler passes it, because
 * unlike a booking there is no DB-authoritative actor for a settings row. The
 * value is stored as jsonb, so a number stays a number and a string a string.
 */
export async function setPlatformSetting<K extends PlatformSettingKey>(
  key: K,
  value: PlatformSettingValue<K>,
  updatedBy: string,
  supabase: SupabaseClient<Database> = createServerClient()
): Promise<PlatformSettingValue<K>> {
  const { data, error } = await supabase
    .from('platform_settings')
    .upsert({ key, value, updated_by: updatedBy }, { onConflict: 'key' })
    .select('value')
    .single();
  if (error) throw error;

  const fallback = PLATFORM_SETTINGS_DEFAULTS[key];
  return coerce(key, (data as { value: unknown } | null)?.value, fallback) as PlatformSettingValue<K>;
}
