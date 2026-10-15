/**
 * The status and priority words a support ticket is shown with, shared by the
 * list and the thread so the two can never disagree about what "pending" says.
 *
 * A ticket's status is the console's word: `open` is waiting on support, `pending`
 * is waiting on the customer, `resolved` is answered, `closed` is done. The
 * customer-facing label spells that waiting-out rather than repeating the enum.
 */
export const TICKET_STATUS_COPY: Record<string, { label: string; tone: string }> = {
  open: { label: 'Open', tone: 'bg-blue-100 text-blue-800' },
  pending: { label: 'Awaiting your reply', tone: 'bg-amber-100 text-amber-800' },
  resolved: { label: 'Resolved', tone: 'bg-green-100 text-green-800' },
  closed: { label: 'Closed', tone: 'bg-gray-100 text-gray-700' },
};

export const TICKET_PRIORITY_COPY: Record<string, { label: string; tone: string }> = {
  low: { label: 'Low', tone: 'bg-gray-100 text-gray-700' },
  normal: { label: 'Normal', tone: 'bg-gray-100 text-gray-700' },
  high: { label: 'High', tone: 'bg-orange-100 text-orange-800' },
  urgent: { label: 'Urgent', tone: 'bg-red-100 text-red-700' },
};

export function ticketStatus(status: string): { label: string; tone: string } {
  return TICKET_STATUS_COPY[status] ?? { label: status, tone: 'bg-gray-100 text-gray-700' };
}
