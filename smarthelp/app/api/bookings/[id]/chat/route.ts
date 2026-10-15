import { ApiHttpError, handle, ok } from '@/lib/api';
import { getBookingChatContext, getOrCreateThreadForBooking, listMessages } from '@/lib/chatServer';
import { isStaffRole } from '@/lib/roles';
import { requireAuth, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/bookings/:id/chat — the booking's thread and its history (§25.9).
 *
 * A booking with no assigned professional has no chat, and the answer is the
 * same 404 a stranger gets: the thread only comes into being for a booking that
 * actually has both participants. Staff may read a thread but are not a
 * participant in it.
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'bookings.chat', async () => {
    const auth = await requireAuth(req);
    const bookingId = uuid(params.id, 'id');

    const context = await getBookingChatContext(bookingId);
    if (!context) {
      throw new ApiHttpError('NOT_FOUND', 'That booking was not found.', 404);
    }
    if (!context.professionalProfileId) {
      throw new ApiHttpError('NOT_FOUND', 'This booking has no chat yet.', 404);
    }

    const isParticipant =
      auth.userId === context.customerProfileId ||
      auth.userId === context.professionalProfileId;
    if (!isParticipant && !isStaffRole(auth.role)) {
      throw new ApiHttpError('NOT_FOUND', 'That booking was not found.', 404);
    }

    const thread = await getOrCreateThreadForBooking(bookingId);
    if (!thread) {
      // Unreachable while the context above held, but a thread whose
      // participants no longer resolve is not something to serve half of.
      throw new ApiHttpError('NOT_FOUND', 'This booking has no chat yet.', 404);
    }
    const messages = await listMessages(thread.id);

    return ok({ thread, messages, canPost: isParticipant });
  });
}
