import { createServerClient } from './supabaseServer';
import { parseNumeric, rupees, sumPaise, toPaise } from './money';

/**
 * The professional earnings read model (Phase 4 completion).
 *
 * `professional_earnings` (0021) is written by `complete_job`, one row per
 * booking, and this module is the only reader the browser reaches. It exists
 * because the ledger columns are `numeric` strings and the screen wants a
 * summary and a list: the two queries are folded into one place so the route
 * stays a decision, not an assembly.
 *
 * Scope rule mirrored from `professionalServer`: the caller arrives already
 * authenticated as the professional whose id this is called with. The module
 * filters by that id and nothing else, so professional A's rows can never
 * appear in B's response regardless of what the route forgot.
 */

export type EarningStatus = 'pending' | 'available' | 'paid' | 'reversed';

export interface EarningsEntry {
  id: string;
  bookingId: string;
  bookingNumber: string | null;
  /** The service name of the booking's first line, when the booking still exists. */
  serviceName: string | null;
  grossAmount: number;
  commissionAmount: number;
  netAmount: number;
  bonusAmount: number;
  status: EarningStatus;
  availableAt: string | null;
  reversedReason: string | null;
  createdAt: string;
}

export interface EarningsSummary {
  /** All money figures are rupees, converted at the `money.ts` boundary. */
  lifetimeGross: number;
  lifetimeNet: number;
  /** Cleared but not yet paid: `pending` + `available`. */
  heldNet: number;
  availableNet: number;
  paidNet: number;
  reversedNet: number;
  counts: Record<EarningStatus, number>;
}

interface RawEarningRow {
  id: string;
  booking_id: string;
  gross_amount: string | number;
  commission_amount: string | number;
  net_amount: string | number;
  bonus_amount: string | number;
  status: EarningStatus;
  available_at: string | null;
  reversed_reason: string | null;
  created_at: string;
}

export async function getEarnings(professionalId: string): Promise<{
  summary: EarningsSummary;
  earnings: EarningsEntry[];
}> {
  const supabase = createServerClient();

  const { data, error } = await supabase
    .from('professional_earnings')
    .select(
      'id, booking_id, gross_amount, commission_amount, net_amount, bonus_amount, status, available_at, reversed_reason, created_at'
    )
    .eq('professional_id', professionalId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const rows = (data ?? []) as unknown as RawEarningRow[];

  // The two lookups that turn ids into sentences. Three queries in parallel
  // beats one page assembling from three round trips — the same argument the
  // booking detail route makes.
  const bookingIds = Array.from(new Set(rows.map((r) => r.booking_id)));
  let bookingNumbers: Record<string, string> = {};
  let serviceNames: Record<string, string> = {};
  if (bookingIds.length > 0) {
    const [bookRes, itemRes] = await Promise.all([
      supabase.from('bookings').select('id, booking_number').in('id', bookingIds),
      supabase
        .from('booking_items')
        .select('booking_id, service_name')
        .in('booking_id', bookingIds)
        .order('created_at', { ascending: true }),
    ]);
    if (bookRes.error) throw bookRes.error;
    if (itemRes.error) throw itemRes.error;

    bookingNumbers = Object.fromEntries(
      (bookRes.data ?? []).map((b) => [b.id, b.booking_number])
    );
    serviceNames = Object.fromEntries(
      (itemRes.data ?? []).map((i) => [i.booking_id, i.service_name])
    );
  }

  const paiseByStatus: Record<EarningStatus, number[]> = {
    pending: [],
    available: [],
    paid: [],
    reversed: [],
  };
  const grossByStatus: Record<EarningStatus, number[]> = {
    pending: [],
    available: [],
    paid: [],
    reversed: [],
  };

  const earnings: EarningsEntry[] = rows.map((row) => {
    const netPaise = toPaise(parseNumeric(row.net_amount));
    const grossPaise = toPaise(parseNumeric(row.gross_amount));
    paiseByStatus[row.status].push(netPaise);
    grossByStatus[row.status].push(grossPaise);

    return {
      id: row.id,
      bookingId: row.booking_id,
      bookingNumber: bookingNumbers[row.booking_id] ?? null,
      serviceName: serviceNames[row.booking_id] ?? null,
      grossAmount: parseNumeric(row.gross_amount),
      commissionAmount: parseNumeric(row.commission_amount),
      netAmount: parseNumeric(row.net_amount),
      bonusAmount: parseNumeric(row.bonus_amount),
      status: row.status,
      availableAt: row.available_at,
      reversedReason: row.reversed_reason,
      createdAt: row.created_at,
    };
  });

  const heldPaise = sumPaise([...paiseByStatus.pending, ...paiseByStatus.available]);

  const summary: EarningsSummary = {
    lifetimeGross: rupees(sumPaise([...Object.values(grossByStatus).flat()])),
    lifetimeNet: rupees(sumPaise([...Object.values(paiseByStatus).flat()])),
    heldNet: rupees(heldPaise),
    availableNet: rupees(sumPaise(paiseByStatus.available)),
    paidNet: rupees(sumPaise(paiseByStatus.paid)),
    reversedNet: rupees(sumPaise(paiseByStatus.reversed)),
    counts: {
      pending: paiseByStatus.pending.length,
      available: paiseByStatus.available.length,
      paid: paiseByStatus.paid.length,
      reversed: paiseByStatus.reversed.length,
    },
  };

  return { summary, earnings };
}