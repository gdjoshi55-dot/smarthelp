import { createServerClient } from './supabaseServer';
import { parseNumeric } from './money';
import type { CancellationPolicyRow } from './cancellation';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, PricingRule, CancellationPolicy } from './supabase';

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