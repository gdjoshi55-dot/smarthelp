import { createServerClient } from './supabaseServer';
import { parseNumeric, toPaise, numericLiteral } from './money';
import type { CancellationPolicyRow } from './cancellation';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Database,
  PricingRule,
  CancellationPolicy,
  CancellationFeeType,
  TablesUpdate,
} from './supabase';

/**
 * The Phase 6 wave-C read/write helpers over the policy tables (§7.1, §11.1,
 * §24) — `pricing_rules`, `cancellation_policies` and, through `refundServer`,
 * the refund console. Server-only, service-role, exactly like the rest of
 * `lib/adminServer.ts` (D3): the Route Handler authenticates the staff member
 * and checks the capability; this module never re-asks who is asking.
 *
 * Two conversions live here that the rest of the app depends on:
 *
 *   `cancellation_policies` rows → `CancellationPolicyRow`, the shape
 *   `lib/cancellation.ts` resolves. The DB stores the band ceiling as
 *   `hours_before` (NULL = unbounded), the same field the pure function reads,
 *   so the rows from this module can be handed to `quoteCancellation` verbatim.
 *
 *   `pricing_rules` rows → a resolved surge multiplier. The engine's
 *   `priceQuote` takes a plain number, so this module's pure function,
 *   `resolveSurgeMultiplier`, is where a rule becomes that number.
 */

type ServerClient = SupabaseClient<Database>;

/** Conversion shared by the list and edit endpoints. */
export function cancellationsToRows(rows: CancellationPolicy[]): CancellationPolicyRow[] {
  return rows.map((r) => ({
    serviceId: r.service_id,
    hoursBefore: r.hours_before === null ? null : parseNumeric(r.hours_before),
    feeType: r.fee_type,
    feeValue: parseNumeric(r.fee_value),
    appliesWhenArrived: r.applies_when_arrived,
    band: r.band ?? undefined,
  }));
}

/** The §11.1 ladder, as `CancellationPolicyRow[]` for `quoteCancellation`. */
export async function loadCancellationPolicies(
  supabase: ServerClient = createServerClient()
): Promise<CancellationPolicyRow[]> {
  const { data, error } = await supabase
    .from('cancellation_policies')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return cancellationsToRows((data ?? []) as CancellationPolicy[]);
}

/** All surge rules, active first, most specific scope resolution at read time. */
export async function listPricingRules(
  supabase: ServerClient = createServerClient()
): Promise<PricingRule[]> {
  const { data, error } = await supabase
    .from('pricing_rules')
    .select('*')
    .order('is_active', { ascending: false })
    .order('priority', { ascending: false });
  if (error) throw error;
  return (data ?? []) as PricingRule[];
}

export interface SurgeQuery {
  /** The service being quoted. Rules that name it are most specific. */
  serviceId: string;
  /** The service's top-level category, for `category` scope rules. */
  categoryId: string | null | undefined;
  /** Local wall-clock minute of the day (0–1439). */
  minute: number;
  /** 0=Sunday … 6=Saturday. */
  dayOfWeek: number;
  rules?: readonly PricingRule[];
}

export interface SurgeResolution {
  multiplier: number;
  /** The rule that won, or null for "no surge". */
  rule: PricingRule | null;
}

function inWindow(rule: PricingRule, minute: number): boolean {
  if (rule.start_minute == null || rule.end_minute == null) return true;
  if (rule.start_minute < rule.end_minute) {
    return minute >= rule.start_minute && minute < rule.end_minute;
  }
  // end_minute < start_minute is a window that wraps midnight.
  return minute >= rule.start_minute || minute < rule.end_minute;
}

const SCOPE_WEIGHT = { service: 3, category: 2, global: 1 } as const;

function scopeSort(a: PricingRule, b: PricingRule): number {
  return (
    SCOPE_WEIGHT[b.scope] - SCOPE_WEIGHT[a.scope] ||
    b.priority - a.priority ||
    a.created_at.localeCompare(b.created_at)
  );
}

/**
 * The winning surge multiplier for a service at a moment, or 1 (no surge).
 *
 * Pure and exported for the same reason `resolveCancellationPolicy` is: the
 * dialog that shows "this hour is 1.2×" and the engine that actually prices it
 * must agree, and a test asserts the winner without re-deriving it. A rule
 * applies when its scope target matches, its day-of-week set is empty or
 * contains `dayOfWeek`, its minute window contains `minute`, it is active, and
 * `now` is inside its validity window. Ties break on scope weight, then
 * priority; a narrower scope should carry a higher priority.
 */
export function resolveSurgeMultiplier(query: SurgeQuery): SurgeResolution {
  const rules = query.rules ?? [];
  const now = new Date().toISOString();
  const applicable = rules.filter((rule) => {
    if (!rule.is_active) return false;
    if (rule.valid_from && rule.valid_from > now) return false;
    if (rule.valid_to && rule.valid_to < now) return false;
    if (rule.scope === 'service' && rule.service_id !== query.serviceId) return false;
    if (rule.scope === 'category' && rule.category_id !== query.categoryId) return false;
    if (rule.days_of_week.length > 0 && !rule.days_of_week.includes(query.dayOfWeek)) return false;
    return inWindow(rule, query.minute);
  });

  const winner = [...applicable].sort(scopeSort)[0] ?? null;
  return { multiplier: winner ? parseNumeric(winner.multiplier) : 1, rule: winner };
}

// ── The console's writes ────────────────────────────────────
//
// The Route Handlers validate, authenticate and audit; these helpers only make
// the row. Numeric columns take decimal strings (PostgREST's rule for a
// `numeric` column, the same reason `numericLiteral` exists); money — a fixed
// cancellation fee — is paise-exact, a non-money decimal (hours, a multiplier,
// a percent) is the decimal itself.

function dec(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError(`Not a finite number: ${value}`);
  return String(value);
}

export const PRICING_RULE_SCOPES = ['global', 'category', 'service'] as const;

export interface PricingRuleInput {
  name: string;
  scope: (typeof PRICING_RULE_SCOPES)[number];
  categoryId?: string | null;
  serviceId?: string | null;
  multiplier: number;
  daysOfWeek?: number[];
  startMinute?: number | null;
  endMinute?: number | null;
  priority?: number;
  validFrom?: string | null;
  validTo?: string | null;
  isActive?: boolean;
}

function pricingRuleRow(input: PricingRuleInput) {
  return {
    name: input.name,
    scope: input.scope,
    category_id: input.scope === 'category' ? input.categoryId ?? null : null,
    service_id: input.scope === 'service' ? input.serviceId ?? null : null,
    multiplier: dec(input.multiplier),
    days_of_week: input.daysOfWeek ?? [],
    start_minute: input.startMinute ?? null,
    end_minute: input.endMinute ?? null,
    priority: input.priority ?? 0,
    valid_from: input.validFrom ?? null,
    valid_to: input.validTo ?? null,
    is_active: input.isActive ?? true,
  };
}

export async function createPricingRule(
  input: PricingRuleInput,
  supabase: ServerClient = createServerClient()
): Promise<PricingRule> {
  const { data, error } = await supabase
    .from('pricing_rules')
    .insert(pricingRuleRow(input))
    .select('*')
    .single();
  if (error) throw error;
  return data as PricingRule;
}

export async function updatePricingRule(
  id: string,
  patch: Partial<PricingRuleInput>,
  supabase: ServerClient = createServerClient()
): Promise<PricingRule> {
  const row: TablesUpdate<'pricing_rules'> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.scope !== undefined) {
    row.scope = patch.scope;
    row.category_id = patch.scope === 'category' ? patch.categoryId ?? null : null;
    row.service_id = patch.scope === 'service' ? patch.serviceId ?? null : null;
  }
  if (patch.multiplier !== undefined) row.multiplier = dec(patch.multiplier);
  if (patch.daysOfWeek !== undefined) row.days_of_week = patch.daysOfWeek;
  if (patch.startMinute !== undefined) row.start_minute = patch.startMinute;
  if (patch.endMinute !== undefined) row.end_minute = patch.endMinute;
  if (patch.priority !== undefined) row.priority = patch.priority;
  if (patch.validFrom !== undefined) row.valid_from = patch.validFrom;
  if (patch.validTo !== undefined) row.valid_to = patch.validTo;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;

  const { data, error } = await supabase
    .from('pricing_rules')
    .update(row)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as PricingRule;
}

export async function deletePricingRule(
  id: string,
  supabase: ServerClient = createServerClient()
): Promise<void> {
  const { error } = await supabase.from('pricing_rules').delete().eq('id', id);
  if (error) throw error;
}

/** The §11.1 ladder raw, with ids and `is_active`, for the console editor. */
export async function listCancellationPolicies(
  supabase: ServerClient = createServerClient()
): Promise<CancellationPolicy[]> {
  const { data, error } = await supabase
    .from('cancellation_policies')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []) as CancellationPolicy[];
}

export interface CancellationPolicyInput {
  serviceId?: string | null;
  /** The band ceiling in hours; null = unbounded ("≥ 24h"). */
  hoursBefore?: number | null;
  feeType: CancellationFeeType;
  /** Percent (0–100) for `percentage`, rupees for `fixed`, 0 for `free`. */
  feeValue: number;
  appliesWhenArrived?: boolean;
  band?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

function cancellationRow(input: CancellationPolicyInput) {
  return {
    service_id: input.serviceId ?? null,
    hours_before: input.hoursBefore === null || input.hoursBefore === undefined ? null : dec(input.hoursBefore),
    fee_type: input.feeType,
    fee_value:
      input.feeType === 'percentage'
        ? dec(input.feeValue)
        : numericLiteral(toPaise(input.feeValue)),
    applies_when_arrived: input.appliesWhenArrived ?? false,
    band: input.band ?? null,
    sort_order: input.sortOrder ?? 0,
    is_active: input.isActive ?? true,
  };
}

export async function createCancellationPolicy(
  input: CancellationPolicyInput,
  supabase: ServerClient = createServerClient()
): Promise<CancellationPolicy> {
  const { data, error } = await supabase
    .from('cancellation_policies')
    .insert(cancellationRow(input))
    .select('*')
    .single();
  if (error) throw error;
  return data as CancellationPolicy;
}

export async function updateCancellationPolicy(
  id: string,
  patch: Partial<CancellationPolicyInput>,
  supabase: ServerClient = createServerClient()
): Promise<CancellationPolicy> {
  const row: TablesUpdate<'cancellation_policies'> = {};
  if (patch.serviceId !== undefined) row.service_id = patch.serviceId;
  if (patch.hoursBefore !== undefined)
    row.hours_before = patch.hoursBefore === null ? null : dec(patch.hoursBefore);
  if (patch.feeType !== undefined) row.fee_type = patch.feeType;
  if (patch.feeValue !== undefined)
    row.fee_value =
      (patch.feeType ?? 'fixed') === 'percentage'
        ? dec(patch.feeValue)
        : numericLiteral(toPaise(patch.feeValue));
  if (patch.appliesWhenArrived !== undefined) row.applies_when_arrived = patch.appliesWhenArrived;
  if (patch.band !== undefined) row.band = patch.band;
  if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;

  const { data, error } = await supabase
    .from('cancellation_policies')
    .update(row)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as CancellationPolicy;
}

export async function deleteCancellationPolicy(
  id: string,
  supabase: ServerClient = createServerClient()
): Promise<void> {
  const { error } = await supabase.from('cancellation_policies').delete().eq('id', id);
  if (error) throw error;
}