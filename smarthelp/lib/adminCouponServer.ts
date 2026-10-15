import { createServerClient } from './supabaseServer';
import { parseNumeric, toPaise, numericLiteral } from './money';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Coupon, CouponUsage, Database, DiscountType, TablesUpdate } from './supabase';

/**
 * The coupon console's read/write helpers (Phase 6, wave C; §9, §24, §31.1).
 *
 * Same shape as the rest of the admin server modules: service-role, no RLS
 * re-check (the Route Handler gates the caller), money leaves as numbers and
 * goes in as paise-exact `numeric` strings. `usage_count` on the row is only a
 * cache for "x of y left" — `coupon_usage` is the truth, so the detail screen
 * attaches the actual usage rows.
 */

type ServerClient = SupabaseClient<Database>;

function dec(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError(`Not a finite number: ${value}`);
  return String(value);
}

export interface AdminCouponListItem {
  id: string;
  code: string;
  description: string | null;
  discountType: DiscountType;
  discountValue: number;
  maxDiscount: number | null;
  minBookingAmount: number;
  validFrom: string;
  validTo: string | null;
  usageLimit: number | null;
  usageCount: number;
  perUserLimit: number;
  firstTimeOnly: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface AdminCouponListFilters {
  q?: string;
  /** `active` = valid_now_and_enabled, `expired` = past `valid_to`, else all. */
  status?: 'active' | 'expired';
  limit?: number;
  offset?: number;
}

export async function listAdminCoupons(
  filters: AdminCouponListFilters = {},
  supabase: ServerClient = createServerClient()
): Promise<{ coupons: AdminCouponListItem[]; total: number }> {
  const limit = filters.limit ?? 25;
  const offset = filters.offset ?? 0;

  let query = supabase.from('coupons').select('*', { count: 'exact' });
  if (filters.q) query = query.ilike('code', `%${filters.q}%`);
  if (filters.status === 'expired') query = query.lt('valid_to', new Date().toISOString());
  if (filters.status === 'active') {
    const now = new Date().toISOString();
    query = query.eq('is_active', true).or(`valid_to.is.null,valid_to.gte.${now}`);
  }

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const rows = (data ?? []) as Coupon[];
  return {
    coupons: rows.map(toListItem),
    total: count ?? rows.length,
  };
}

function toListItem(row: Coupon): AdminCouponListItem {
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    discountType: row.discount_type,
    discountValue: parseNumeric(row.discount_value),
    maxDiscount: row.max_discount === null ? null : parseNumeric(row.max_discount),
    minBookingAmount: parseNumeric(row.min_booking_amount),
    validFrom: row.valid_from,
    validTo: row.valid_to,
    usageLimit: row.usage_limit,
    usageCount: row.usage_count,
    perUserLimit: row.per_user_limit,
    firstTimeOnly: row.first_time_only,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

export interface AdminCouponDetail extends AdminCouponListItem {
  maxDiscountPctOfTotal: number;
  applicableServices: string[];
  applicableCities: string[];
  usage: CouponUsage[];
}

export async function getAdminCoupon(
  couponId: string,
  supabase: ServerClient = createServerClient()
): Promise<AdminCouponDetail | null> {
  const { data, error } = await supabase
    .from('coupons')
    .select('*')
    .eq('id', couponId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const { data: usage, error: usageError } = await supabase
    .from('coupon_usage')
    .select('*')
    .eq('coupon_id', couponId)
    .order('used_at', { ascending: false })
    .limit(50);
  if (usageError) throw usageError;

  return {
    ...toListItem(data as Coupon),
    maxDiscountPctOfTotal: parseNumeric((data as Coupon).max_discount_pct_of_total),
    applicableServices: (data as Coupon).applicable_services,
    applicableCities: (data as Coupon).applicable_cities,
    usage: (usage ?? []) as CouponUsage[],
  };
}

export interface AdminCouponInput {
  code: string;
  description?: string | null;
  discountType: DiscountType;
  /** Rupees for `fixed`, percent (0–100) for `percentage`. */
  discountValue: number;
  maxDiscount?: number | null;
  minBookingAmount?: number;
  maxDiscountPctOfTotal?: number;
  validFrom: string;
  validTo?: string | null;
  usageLimit?: number | null;
  perUserLimit?: number;
  applicableServices?: string[];
  applicableCities?: string[];
  firstTimeOnly?: boolean;
  isActive?: boolean;
}

function couponRow(input: AdminCouponInput) {
  return {
    code: input.code.toUpperCase(),
    description: input.description ?? null,
    discount_type: input.discountType,
    discount_value:
      input.discountType === 'percentage'
        ? dec(input.discountValue)
        : numericLiteral(toPaise(input.discountValue)),
    max_discount:
      input.maxDiscount === null || input.maxDiscount === undefined
        ? null
        : numericLiteral(toPaise(input.maxDiscount)),
    min_booking_amount: numericLiteral(toPaise(input.minBookingAmount ?? 0)),
    max_discount_pct_of_total: dec(input.maxDiscountPctOfTotal ?? input.discountType === 'percentage' ? 100 : 0),
    valid_from: input.validFrom,
    valid_to: input.validTo ?? null,
    usage_limit: input.usageLimit ?? null,
    per_user_limit: input.perUserLimit ?? 1,
    applicable_services: input.applicableServices ?? [],
    applicable_cities: input.applicableCities ?? [],
    first_time_only: input.firstTimeOnly ?? false,
    is_active: input.isActive ?? true,
  };
}

export async function createCoupon(
  input: AdminCouponInput,
  supabase: ServerClient = createServerClient()
): Promise<Coupon> {
  const { data, error } = await supabase
    .from('coupons')
    .insert(couponRow(input))
    .select('*')
    .single();
  if (error) throw error;
  return data as Coupon;
}

export async function updateCoupon(
  id: string,
  patch: Partial<AdminCouponInput>,
  supabase: ServerClient = createServerClient()
): Promise<Coupon> {
  const row: TablesUpdate<'coupons'> = {};
  if (patch.code !== undefined) row.code = patch.code.toUpperCase();
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.discountType !== undefined || patch.discountValue !== undefined) {
    if (patch.discountType === undefined || patch.discountValue === undefined) {
      throw new TypeError('discountType and discountValue must be updated together');
    }
    row.discount_type = patch.discountType;
    row.discount_value =
      patch.discountType === 'percentage'
        ? dec(patch.discountValue)
        : numericLiteral(toPaise(patch.discountValue));
  }
  if (patch.maxDiscount !== undefined)
    row.max_discount = patch.maxDiscount === null ? null : numericLiteral(toPaise(patch.maxDiscount));
  if (patch.minBookingAmount !== undefined) row.min_booking_amount = numericLiteral(toPaise(patch.minBookingAmount));
  if (patch.maxDiscountPctOfTotal !== undefined) row.max_discount_pct_of_total = dec(patch.maxDiscountPctOfTotal);
  if (patch.validFrom !== undefined) row.valid_from = patch.validFrom;
  if (patch.validTo !== undefined) row.valid_to = patch.validTo;
  if (patch.usageLimit !== undefined) row.usage_limit = patch.usageLimit;
  if (patch.perUserLimit !== undefined) row.per_user_limit = patch.perUserLimit;
  if (patch.applicableServices !== undefined) row.applicable_services = patch.applicableServices;
  if (patch.applicableCities !== undefined) row.applicable_cities = patch.applicableCities;
  if (patch.firstTimeOnly !== undefined) row.first_time_only = patch.firstTimeOnly;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;

  const { data, error } = await supabase
    .from('coupons')
    .update(row)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as Coupon;
}