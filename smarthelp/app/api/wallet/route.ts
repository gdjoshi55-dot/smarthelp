import { ApiHttpError, handle, ok } from '@/lib/api';
import { parsePaging, requireAuth, readJson, num } from '@/lib/validation';
import { requireCustomer } from '@/lib/addressServer';
import { parseNumeric, rupees, toPaise } from '@/lib/money';
import { createServerClient } from '@/lib/supabaseServer';
import { debitWallet } from '@/lib/walletServer';
import type { WalletTransaction } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/wallet — the balance and the ledger behind it (§12.4, §25.4).
 *
 * The balance is a cache of `wallet_transactions`; the ledger is the truth, so
 * this route reads both and the ledger is what the page trusts. The wallet is not
 * created on a read: a customer who has never held credit has no row, and the
 * honest answer for them is a zero balance with an empty ledger, not a write
 * disguised as a GET. `GET /api/refunds` carries the refund history that credits
 * this ledger, and is read separately by the same page.
 *
 * Ownership is enforced here from the resolved `customers.id`, never from a query
 * string: the handler reaches Postgres as the service role, which bypasses RLS,
 * so a customer reading somebody else's wallet would otherwise be a matter of
 * guessing a uuid.
 */
export async function GET(req: Request) {
  return handle(req, 'wallet.get', async () => {
    await requireAuth(req);
    const { customer } = await requireCustomer(req);
    const url = new URL(req.url);
    const { limit, offset } = parsePaging(url);

    const supabase = createServerClient();

    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('id, balance')
      .eq('customer_id', customer.id)
      .maybeSingle();
    if (walletError) throw walletError;

    if (!wallet) {
      return ok({ balance: 0, transactions: [], total: 0, limit, offset });
    }

    const { data, error, count } = await supabase
      .from('wallet_transactions')
      .select('*', { count: 'exact' })
      .eq('wallet_id', wallet.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    return ok({
      balance: rupees(toPaise(parseNumeric(wallet.balance))),
      transactions: ((data ?? []) as WalletTransaction[]).map(present),
      total: count ?? 0,
      limit,
      offset,
    });
  });
}

function present(txn: WalletTransaction) {
  return {
    id: txn.id,
    type: txn.type,
    amount: rupees(toPaise(parseNumeric(txn.amount))),
    balanceAfter: rupees(toPaise(parseNumeric(txn.balance_after))),
    refType: txn.ref_type,
    refId: txn.ref_id,
    description: txn.description,
    createdAt: txn.created_at,
  };
}


/**
 * POST /api/wallet/redeem - spend wallet balance (creates a debit txn).
 * Body: { amount } (rupees).
 */
export async function POST(req: Request) {
  return handle(req, 'wallet.redeem', async () => {
    const { customer } = await requireCustomer(req);
    const body = await readJson(req);
    const amount = num(body.amount, 'amount');
    if (amount <= 0) {
      throw new ApiHttpError('VALIDATION_ERROR', 'amount must be greater than 0', 400);
    }
    const amountPaise = toPaise(amount);
    const supabase = createServerClient();
    await debitWallet(supabase, customer.id, amountPaise, 'redeem:wallet', 'Wallet redemption');
    return ok({ success: true });
  });
}
