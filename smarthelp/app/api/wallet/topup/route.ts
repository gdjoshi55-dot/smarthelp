import { ApiHttpError, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { rupees, toPaise } from '@/lib/money';
import { createServerClient } from '@/lib/supabaseServer';
import { optionalStr, readJson, requireCapability, num, uuid } from '@/lib/validation';
import { creditWallet } from '@/lib/walletServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/wallet/topup — add credit to a customer's wallet (§25.8).
 *
 * **v1 is promo/ops credit only.** §2 lists in-app card top-up as an explicit
 * non-goal for this version — the wallet is "refund / promo / referral /
 * compensation credit only" — so this route does not create a Razorpay order.
 * It is the ops lever behind that sentence: a staff member with `wallet.credit`
 * (ops, admin or owner) grants a figure to a named customer, and the movement
 * lands in `wallet_transactions` as a `credit` under a `topup:` reference.
 *
 * The write is the same one every other credit uses — `creditWallet`, and so
 * `apply_wallet_delta()`. There is no second path to a wallet balance, which is
 * what keeps the ledger and the cached balance from ever disagreeing.
 */
export async function POST(req: Request) {
  return handle(req, 'wallet.topup', async (requestId) => {
    const auth = await requireCapability(req, 'wallet.credit');
    const body = await readJson(req);

    const customerId = uuid(body.customerId, 'customerId');
    const amount = num(body.amount, 'amount', { min: 0 });
    if (amount <= 0) {
      throw new ApiHttpError('VALIDATION_ERROR', 'The top-up amount must be greater than zero.', 400, {
        fields: { amount: 'Enter an amount greater than zero' },
      });
    }
    const reason = optionalStr(body.reason, 'reason', { max: 200 });

    const supabase = createServerClient();

    // The wallet is keyed on `customers.id`, not `profiles.id`. A bad id here
    // would otherwise create a wallet hanging off nobody.
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('id')
      .eq('id', customerId)
      .maybeSingle();
    if (customerError) throw customerError;
    if (!customer) {
      throw new ApiHttpError('NOT_FOUND', 'That customer does not exist.', 404, {
        fields: { customerId: 'Unknown customer' },
      });
    }

    const amountPaise = toPaise(amount);
    const result = await creditWallet(
      supabase,
      customerId,
      amountPaise,
      `topup:${requestId}`,
      reason ?? 'Wallet top-up (ops credit)'
    );

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'wallet.topup',
      entityType: 'wallets',
      entityId: result.walletId,
      after: { customerId, amount },
      metadata: { reason: reason ?? null },
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({
      walletId: result.walletId,
      balance: rupees(result.balancePaise),
      credited: amount,
    });
  });
}
