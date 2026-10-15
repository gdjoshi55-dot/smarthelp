import { ApiHttpError, created, handle, ok } from '@/lib/api';
import { getThreadView, listMessages, postMessage } from '@/lib/chatServer';
import { isStaffRole } from '@/lib/roles';
import { optionalStr, oneOf, readJson, requireAuth, uuid } from '@/lib/validation';
import type { ChatMessageKind } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS: ChatMessageKind[] = ['text', 'image', 'system'];

/**
 * GET /api/chat/threads/:id/messages — a thread's history (§25.9).
 *
 * Participants and staff may read. Anyone else gets the same 404 as a thread id
 * that does not exist, so the endpoint is not a way to discover whose threads
 * exist.
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'chat.messages.list', async () => {
    const auth = await requireAuth(req);
    const threadId = uuid(params.id, 'id');

    const thread = await getThreadView(threadId);
    if (!thread) {
      throw new ApiHttpError('NOT_FOUND', 'That conversation was not found.', 404);
    }
    const isParticipant =
      auth.userId === thread.customerProfileId || auth.userId === thread.professionalProfileId;
    if (!isParticipant && !isStaffRole(auth.role)) {
      throw new ApiHttpError('NOT_FOUND', 'That conversation was not found.', 404);
    }

    const messages = await listMessages(threadId);
    return ok({ thread, messages, canPost: isParticipant });
  });
}

/**
 * POST /api/chat/threads/:id/messages — send a message (§25.9).
 *
 * Only the two participants may post; staff may read but not write. A `system`
 * message is server-only, so a client that asks for one is refused rather than
 * trusted — the same rule §24.11 states.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'chat.messages.post', async () => {
    const auth = await requireAuth(req);
    const threadId = uuid(params.id, 'id');

    const thread = await getThreadView(threadId);
    if (!thread) {
      throw new ApiHttpError('NOT_FOUND', 'That conversation was not found.', 404);
    }
    const isParticipant =
      auth.userId === thread.customerProfileId || auth.userId === thread.professionalProfileId;
    if (!isParticipant) {
      // A staff member who may read is still not allowed to speak here.
      throw new ApiHttpError('FORBIDDEN', 'Only the booking participants may send messages.', 403);
    }
    if (thread.closedAt) {
      throw new ApiHttpError('INVALID_STATE', 'This conversation is closed.', 409);
    }

    const body = await readJson(req);
    const kind = oneOf(body.kind ?? 'text', 'kind', KINDS);
    if (kind === 'system') {
      throw new ApiHttpError('FORBIDDEN', 'System messages are server-written only.', 403);
    }
    // A JSON body carries text or an image path; multipart upload to the
    // `chat-media` bucket happens earlier and hands back `imagePath`.
    const text = kind === 'text' ? optionalStr(body.body, 'body', { max: 4000 }) : null;
    const imagePath = kind === 'image' ? optionalStr(body.imagePath, 'imagePath', { max: 1024 }) : null;
    if (kind === 'text' && !text) {
      throw new ApiHttpError('VALIDATION_ERROR', 'A text message needs a body.', 400);
    }
    if (kind === 'image' && !imagePath) {
      throw new ApiHttpError('VALIDATION_ERROR', 'An image message needs an imagePath.', 400);
    }

    const message = await postMessage(threadId, {
      senderId: auth.userId,
      kind,
      body: text,
      imagePath,
    });
    return created({ message });
  });
}
