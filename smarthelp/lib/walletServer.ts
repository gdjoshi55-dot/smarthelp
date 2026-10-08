import { ApiHttpError } from './api';
import { numericLiteral, parseNumeric, toPaise } from './money';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, WalletTxnType } from './supabase';

/**
 * The server half of the wallet (§12.4, §24.9).
 *
 * Two movements, and nothing else. A wallet balance can only change through
 * `apply_wallet_delta()` (0015), which writes the balance and its ledger row in
 * one statement or raises before either — so the entire design of this module
 * is "pick the direction, hand over an exact amount, translate the refusal".
 *
 * Three things live here rather than in the caller:
 *
 *   1. **The paise → `numeric` conversion, once.** This is the same boundary
 *      `lib/paymentServer.ts` draws for charges: paise in from the money
 *      arithmetic, `numericLiteral()` out to Postgres, and a JS float never
 *      reaches a `numeric` column. Nothing downstream multiplies by 100 again.
 *   2. **`get_or_create_wallet` first.** Refund-to-wallet has to work for a
 *      customer who has never held credit, and doing that in two round trips
 *      from here would put the read-then-write race back into the place 0015
 *      took it out of.
 *   3. **`WALLET_OVERDRAFT` as an `ApiHttpError`,** not as a raw PostgREST
 *      error. SQLSTATE 23514 with the function's own message is a database
 *      fact; a route has to answer a human with a sentence and a status, and
 *      `handle()` only does that for `ApiHttpError`.
 */

type ServerClient = SupabaseClient<Database>;

export interface WalletDeltaResult {
  /** The `wallets.id` the movement landed on — created here if it did not exist. */
  walletId: string;
  /** The balance after the movement, in paise. */
  balancePaise: number;
}

/**
 * Credit a wallet. `amountPaise` must be a positive integer of paise.
 *
 * `ref` is the ledger's `'type:id'` key — `'refund:<refunds.id>'` is the one
 * this phase writes — and both halves end up on the row, because a credit with
 * no idea *what* it was for is not evidence when a customer disputes it.
 */
export async function creditWallet(
  supabase: ServerClient,
  customerId: string,
  amountPaise: number,
  ref: string,
  description: string
): Promise<WalletDeltaResult> {
  return move(supabase, customerId, 'credit', amountPaise, ref, description);
}

/**
 * Debit a wallet.
 *
 * The amount is still positive: direction is the `type`, never the sign, which
 * is the same rule `apply_wallet_delta()` enforces and the same reason the
 * `amount CHECK (amount > 0)` column exists.
 */
export async function debitWallet(
  supabase: ServerClient,
  customerId: string,
  amountPaise: number,
  ref: string,
  description: string
): Promise<WalletDeltaResult> {
  return move(supabase, customerId, 'debit', amountPaise, ref, description);
}

async function move(
  supabase: ServerClient,
  customerId: string,
  type: WalletTxnType,
  amountPaise: number,
  ref: string,
  description: string
): Promise<WalletDeltaResult> {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    // The invariant this module owns, stated the way `lib/razorpayClient.ts`
    // states its own: a non-integer or non-positive amount here means a caller
    // skipped `lib/money.ts`, and a zero-value ledger row would be worse than a
    // thrown error.
    throw new TypeError(
      `amountPaise must be a positive integer number of paise, got ${amountPaise}`
    );
  }

  if (!ref.includes(':') || ref.split(':')[0] === '') {
    // Caught here rather than as `WALLET_REF_REQUIRED` three frames into SQL,
    // where the message would name a column instead of the caller's mistake.
    throw new TypeError(`ref must be a 'type:id' string, got ${JSON.stringify(ref)}`);
  }

  const { data: walletId, error: walletError } = await supabase.rpc('get_or_create_wallet', {
    p_customer: customerId,
  });
  if (walletError) throw walletError;
  if (!walletId) {
    throw new ApiHttpError('INTERNAL_ERROR', 'The wallet could not be opened. Please try again.', 500, {
      customerId,
    });
  }

  const { data: balance, error } = await supabase.rpc('apply_wallet_delta', {
    p_wallet: walletId,
    p_type: type,
    // A string, not `amountPaise / 100`: PostgREST coerces an exact decimal
    // string to `numeric`, and a division would hand the column the nearest
    // double to the truth instead of the truth.
    p_amount: numericLiteral(amountPaise),
    p_ref: ref,
    p_desc: description,
  });

  if (error) {
    const refusal = translateWalletError(error, type, amountPaise);
    throw refusal ?? error;
  }

  // `parseNumeric` accepts a number or a string because a `returns numeric`
  // scalar comes back as a JSON number while every money *column* comes back
  // as a string — one conversion that is correct either way.
  return { walletId, balancePaise: toPaise(parseNumeric(String(balance ?? 0))) };
}

/**
 * Turn the database's refusal into something a route can answer with.
 *
 * Only `WALLET_OVERDRAFT` is translated: it is the one error a *caller* can
 * legitimately provoke (asking for more than the balance holds), and it becomes
 * `INVALID_STATE` — 409, because the request was well-formed and the wallet is
 * simply not in a state that permits it. Every other code is a defect or a
 * constraint this module already guards, so it is rethrown unchanged rather
 * than being relabelled as something the customer did.
 */
function translateWalletError(
  error: { code?: string; message?: string },
  type: WalletTxnType,
  amountPaise: number
): ApiHttpError | null {
  if (error.code === '23514' && (error.message ?? '').includes('WALLET_OVERDRAFT')) {
    return new ApiHttpError(
      'INVALID_STATE',
      type === 'debit'
        ? 'That amount is more than the wallet balance.'
        : 'The wallet could not take that amount.',
      409,
      { reason: 'wallet_overdraft', amount_paise: amountPaise }
    );
  }
  return null;
}
