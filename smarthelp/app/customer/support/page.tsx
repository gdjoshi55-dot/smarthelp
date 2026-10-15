'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { Headphones, MessageSquarePlus, X } from 'lucide-react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/catalogue/EmptyState';
import { ticketStatus } from '@/components/support/ticketCopy';
import {
  createTicket,
  fetchMyTickets,
  SUPPORT_CATEGORIES,
  SupportApiError,
  type SupportTicketSummary,
} from '@/lib/supportClient';

function NewTicketForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState('booking');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFieldErrors({});
    setSaving(true);
    try {
      await createTicket({ subject: subject.trim(), category, message: message.trim() });
      toast.success('Your request has been sent.');
      onCreated();
    } catch (error) {
      if (error instanceof SupportApiError) {
        if (error.fields) setFieldErrors(error.fields);
        toast.error(error.message);
      } else {
        toast.error('We could not send your request. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">New request</h2>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          aria-label="Cancel"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <form onSubmit={submit} className="mt-4 space-y-4">
        <div>
          <label htmlFor="subject" className="block text-sm font-medium text-gray-700">
            Subject
          </label>
          <input
            id="subject"
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Short summary of the issue"
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          {fieldErrors.subject ? (
            <p className="mt-1 text-xs text-red-600">{fieldErrors.subject}</p>
          ) : null}
        </div>

        <div>
          <label htmlFor="category" className="block text-sm font-medium text-gray-700">
            What is it about?
          </label>
          <select
            id="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {SUPPORT_CATEGORIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="message" className="block text-sm font-medium text-gray-700">
            Tell us what happened
          </label>
          <textarea
            id="message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          {fieldErrors.message ? (
            <p className="mt-1 text-xs text-red-600">{fieldErrors.message}</p>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={saving || !subject.trim() || !message.trim()}
          className="inline-flex items-center gap-2 bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Sending…' : 'Send request'}
        </button>
      </form>
    </section>
  );
}

function SupportView() {
  const [tickets, setTickets] = useState<SupportTicketSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(() => {
    fetchMyTickets()
      .then((res) => setTickets(res.tickets))
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      {showForm ? (
        <NewTicketForm
          onCancel={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      ) : (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-2 bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-blue-700"
          >
            <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
            New request
          </button>
        </div>
      )}

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
          We could not load your requests. Reload the page to try again.
        </div>
      ) : tickets === null ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner size="lg" />
        </div>
      ) : tickets.length === 0 ? (
        <EmptyState
          title="No requests yet"
          message="When you need help with a booking, a payment or your account, raise a request here and track the reply."
          icon={<Headphones className="h-5 w-5" aria-hidden="true" />}
        />
      ) : (
        <ul className="space-y-3">
          {tickets.map((ticket) => {
            const status = ticketStatus(ticket.status);
            return (
              <li key={ticket.id}>
                <Link
                  href={`/customer/support/${ticket.id}`}
                  className="flex items-center justify-between gap-4 rounded-xl border border-gray-200 bg-white p-5 hover:border-blue-200 hover:bg-blue-50/40"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-900">{ticket.subject}</p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {new Date(ticket.createdAt).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                      {' · '}
                      {ticket.category}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${status.tone}`}>
                    {status.label}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function CustomerSupportPage() {
  return (
    <AuthGuard role="customer">
      <RoleShell role="customer" eyebrow="Customer" title="Support">
        <SupportView />
      </RoleShell>
    </AuthGuard>
  );
}
