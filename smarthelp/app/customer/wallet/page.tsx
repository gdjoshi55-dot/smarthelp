'use client';

import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Receipt, Wallet } from 'lucide-react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import {
  fetchRefunds,
  fetchWallet,
  type RefundRow,
  type WalletTransaction,
} from '@/lib/walletClient';

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
});

const REFUND_STATUS_TONE: Record<string, string> = {
  requested: 'bg-amber-100 text-amber-800',
  processing: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-700',
  rejected: 'bg-red-100 text-red-700',
};

async function loadWallet(signal: AbortSignal): Promise<{
  balance: number;
  ledger: WalletTransaction[];
  refunds: RefundRow[];
}> {
  const [wallet, refunds] = await Promise.all([fetchWallet(signal), fetchRefunds(signal)]);
  return { balance: wallet.balance, ledger: wallet.transactions, refunds: refunds.refunds };
}

function WalletView() {
  const [balance, setBalance] = useState<number | null>(null);
  const [ledger, setLedger] = useState<WalletTransaction[]>([]);
  const [refunds, setRefunds] = useState<RefundRow[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    loadWallet(controller.signal)
      .then((data) => {
        setBalance(data.balance);
        setLedger(data.ledger);
        setRefunds(data.refunds);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, []);

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
        We could not load your wallet. Reload the page to try again.
      </div>
    );
  }

  if (balance === null) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-gradient-to-br from-blue-600 to-blue-800 p-6 text-white">
        <p className="flex items-center gap-2 text-sm text-blue-100">
          <Wallet className="h-4 w-4" aria-hidden="true" />
          Wallet balance
        </p>
        <p className="mt-2 text-3xl font-bold tracking-tight">{inr.format(balance)}</p>
        <p className="mt-1 text-xs text-blue-100">
          Refunds that come back as credit land here and are applied at checkout.
        </p>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="text-base font-semibold text-gray-900">Ledger</h2>
          <p className="mt-1 text-sm text-gray-600">
            Every credit and debit, newest first. The running balance is the server&apos;s.
          </p>
          {ledger.length === 0 ? (
            <p className="mt-4 text-sm text-gray-600">
              Nothing yet. Refund credits will appear here.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-gray-100">
              {ledger.map((txn) => (
                <li key={txn.id} className="flex items-center gap-3 py-3">
                  <span
                    className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                      txn.type === 'credit'
                        ? 'bg-green-100 text-green-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {txn.type === 'credit' ? (
                      <ArrowDownLeft className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-gray-900">{txn.description}</p>
                    <p className="text-xs text-gray-500">
                      {new Date(txn.createdAt).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 text-sm font-semibold tabular-nums ${
                      txn.type === 'credit' ? 'text-green-700' : 'text-gray-900'
                    }`}
                  >
                    {txn.type === 'credit' ? '+' : '−'}
                    {inr.format(txn.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
            <Receipt className="h-4 w-4 text-gray-400" aria-hidden="true" />
            Refunds
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Money returned for cancelled or disputed bookings.
          </p>
          {refunds.length === 0 ? (
            <p className="mt-4 text-sm text-gray-600">No refunds on your account.</p>
          ) : (
            <ul className="mt-4 divide-y divide-gray-100">
              {refunds.map((refund) => (
                <li key={refund.id} className="flex items-center justify-between gap-3 py-3">
                  <div>
                    <p className="text-sm text-gray-900">{inr.format(refund.amount)}</p>
                    <p className="text-xs text-gray-500">
                      {new Date(refund.requestedAt).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                      {refund.route ? ` · ${refund.route.replace(/_/g, ' ')}` : ''}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                      REFUND_STATUS_TONE[refund.status] ?? 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {refund.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

export default function CustomerWalletPage() {
  return (
    <AuthGuard role="customer">
      <RoleShell role="customer" eyebrow="Customer" title="Wallet">
        <WalletView />
      </RoleShell>
    </AuthGuard>
  );
}
