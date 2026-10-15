'use client';

import type { ChatMessageView } from '@/lib/chatClient';

/**
 * One message in a booking chat (§24.11).
 *
 * Three renderings, chosen by the row rather than by position:
 *   * `system` — server-written notices, centred and muted, because a status
 *     change is not something either party said.
 *   * the caller's own message — right-aligned, filled.
 *   * the other participant's — left-aligned, outlined.
 *
 * A message's `senderId` is null only for a system row, so `isOwn` is how the
 * caller marks their side; the component never infers ownership from a name.
 */
export function ChatBubble({
  message,
  isOwn,
}: {
  message: ChatMessageView;
  isOwn: boolean;
}) {
  if (message.kind === 'system') {
    return (
      <div className="my-2 text-center">
        <p className="inline-block rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-500">
          {message.body}
        </p>
      </div>
    );
  }

  return (
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
          isOwn
            ? 'bg-blue-600 text-white'
            : 'border border-gray-200 bg-white text-gray-900'
        }`}
      >
        {!isOwn && message.senderName ? (
          <p className="mb-0.5 text-xs font-semibold text-gray-500">{message.senderName}</p>
        ) : null}
        {message.kind === 'image' && message.imagePath ? (
          // The image lives in the private `chat-media` bucket; the panel that
          // embeds this bubble resolves a signed URL. Without one, the path is
          // shown so the message is never contentless.
          <p className="italic opacity-80">{message.imagePath}</p>
        ) : (
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        )}
        <p className={`mt-0.5 text-[10px] ${isOwn ? 'text-blue-100' : 'text-gray-400'}`}>
          {formatTime(message.createdAt)}
        </p>
      </div>
    </div>
  );
}

function formatTime(value: string): string {
  try {
    return new Date(value).toLocaleTimeString('en-IN', {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}
