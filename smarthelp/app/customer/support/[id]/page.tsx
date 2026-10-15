'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { ArrowLeft } from 'lucide-react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { ticketStatus } from '@/components/support/ticketCopy';
import {
  fetchMyTicket,
  replyToTicket,
  SupportApiError,
  type SupportTicketDetail,
} from '@/lib/supportClient';

function ThreadView({ id }: { id: string }) {
  const [detail, setDetail] = useState<SupportTicketDetail | null>(null);
  const [error, setError] = useState<'not_found' | 'error' | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    fetchMyTicket(id)
      .then(setDetail)
      .catch((err) => setError(err instanceof SupportApiError && err.status === 404 ? 'not_found' : 'error'));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const body = reply.trim();
    if (!body || !detail) return;
    setSending(true);
    try {
      const { message } = await replyToTicket(id, body);
      setDetail({ ...detail, messages: [...detail.messages, message] });
      setReply('');
    } catch (err) {
      toast.error(err instanceof SupportApiError ? err.message : 'We could not send your reply.');
    } finally {
      setSending(false);
    }
  }

  if (error === 'not_found') {
    return (
      <div className="space-y-4">
        <p className="text-sm text-gray-600">That request could not be found.</p>
        <Link href="/customer/support" className="text-sm font-semibold text-blue-600 hover:text-blue-700">
          Back to support
        </Link>
      </div>
    );
  }

  if (error === 'error') {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
        We could not load this request. Reload the page to try again.
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const status = ticketStatus(detail.ticket.status);
  const closed = detail.ticket.status === 'closed';

  return (
    <div className="space-y-6">
      <Link
        href="/customer/support"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        All requests
      </Link>

      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{detail.ticket.subject}</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {detail.ticket.category} ·{' '}
              {new Date(detail.ticket.createdAt).toLocaleString('en-IN', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          </div>
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${status.tone}`}>
            {status.label}
          </span>
        </div>

        {detail.ticket.resolvedAt ? (
          <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-xs text-green-800">
            Marked resolved on{' '}
            {new Date(detail.ticket.resolvedAt).toLocaleDateString('en-IN', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
            . Reply below if you still need help.
          </p>
        ) : null}

        <ul className="mt-5 space-y-4">
          {detail.messages.map((message) => (
            <li key={message.id} className={`flex ${message.fromStaff ? 'justify-start' : 'justify-end'}`}>
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                  message.fromStaff
                    ? 'border border-gray-200 bg-white text-gray-900'
                    : 'bg-blue-600 text-white'
                }`}
              >
                {message.fromStaff ? (
                  <p className="mb-0.5 text-xs font-semibold text-gray-500">
                    {message.authorName ?? 'Support team'}
                  </p>
                ) : null}
                <p className="whitespace-pre-wrap break-words">{message.body}</p>
                <p className={`mt-0.5 text-[10px] ${message.fromStaff ? 'text-gray-400' : 'text-blue-100'}`}>
                  {new Date(message.createdAt).toLocaleString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
            </li>
          ))}
        </ul>

        {closed ? (
          <p className="mt-5 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600">
            This request is closed. Open a new one if you still need help.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-5 space-y-3">
            <label htmlFor="reply" className="block text-sm font-medium text-gray-700">
              Reply
            </label>
            <textarea
              id="reply"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={3}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={sending || !reply.trim()}
              className="inline-flex items-center gap-2 bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {sending ? 'Sending…' : 'Send reply'}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

export default function CustomerSupportThreadPage({ params }: { params: { id: string } }) {
  return (
    <AuthGuard role="customer">
      <RoleShell role="customer" eyebrow="Customer" title="Support request">
        <ThreadView id={params.id} />
      </RoleShell>
    </AuthGuard>
  );
}
