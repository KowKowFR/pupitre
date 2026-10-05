import { CHAT_DEFAULT_CHANNEL, PRESENCE_TOUCH_MS, type RealtimeEvent } from '@pupitre/core';
import { countUnreadChat, countUnreadChatMentions } from '@pupitre/db';
import { apiRoute } from '@/lib/http';
import { logger } from '@/lib/logger';
import { isTeamMember, requireSession } from '@/lib/rbac';
import {
  getPresenceChoice,
  onRealtime,
  presenceConnected,
  presenceDisconnected,
  presenceSnapshot,
  presenceTouched,
} from '@/lib/realtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Every four breaths (~100 s), the session is read again: revoked, the stream closes. */
const SESSION_RECHECK_EVERY = 4;

/**
 * A tab's real-time stream: presence, chat, screen signals.
 *
 * Open, it counts as a presence; closed, it removes it. The first message
 * (`hello`) gives the complete state — who is there, how many unread messages —
 * then only changes come. A tab that reconnects therefore starts again from a
 * correct state, without having anything to replay.
 *
 * What an event reveals follows the session's permissions: the log's activity
 * only goes to whoever can read the log. The screen signals, for their part, only
 * carry a topic — the page reads itself again with its own rights. An account
 * without any permission is not part of the team yet: it only receives these
 * signals, neither the chat nor the presence, and nobody sees it online.
 */
export const GET = apiRoute(async (request) => {
  const auth = await requireSession(request);
  const canReadAudit = auth.can('audit:read');
  const member = isTeamMember(auth);
  const encoder = new TextEncoder();

  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  /** A single closing: the client's abort and `cancel()` often both arrive. */
  let cleanup: () => Promise<void> = async () => undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          void cleanup();
        }
      };
      const send = (event: string, data: unknown) =>
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      cleanup = async () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed on the client side.
        }
        if (!member) return;
        await presenceDisconnected(auth.userId).catch((error: unknown) => {
          logger.warn({ err: error }, 'presence not removed');
        });
      };

      // Subscribe before counting the presence: one's own arrival is part of what the
      // tab must see.
      unsubscribe = onRealtime((event: RealtimeEvent) => {
        if (event.type === 'activity' && !canReadAudit) return;
        if (!member && event.type !== 'live') return;
        send(event.type, event);
      });

      try {
        if (member) {
          await presenceConnected(auth.userId);
          const [presence, unread, mentions, choice] = await Promise.all([
            presenceSnapshot(),
            countUnreadChat(auth.userId, CHAT_DEFAULT_CHANNEL),
            countUnreadChatMentions(auth.userId, CHAT_DEFAULT_CHANNEL),
            getPresenceChoice(auth.userId),
          ]);
          send('hello', { me: auth.userId, presence, unread, mentions, choice });
        } else {
          send('hello', { me: auth.userId, presence: {}, unread: 0, mentions: 0, choice: null });
        }
      } catch (error) {
        logger.error({ err: error }, 'real-time stream unavailable');
        send('error', { code: 'unavailable' });
        await cleanup();
        return;
      }

      let beats = 0;
      heartbeat = setInterval(() => {
        beats += 1;
        // A reverse proxy cuts a silent connection: the comment keeps it open.
        write(': heartbeat\n\n');
        if (member) void presenceTouched(auth.userId).catch(() => undefined);
        if (beats % SESSION_RECHECK_EVERY === 0) {
          requireSession(request).then(
            (fresh) => {
              // A role given or removed changes what the stream may carry: we close it, the tab
              // reloads and opens a new one with its rights.
              if (isTeamMember(fresh) === member) return;
              send('bye', { reason: 'role' });
              void cleanup();
            },
            () => {
              send('bye', { reason: 'session' });
              void cleanup();
            },
          );
        }
      }, PRESENCE_TOUCH_MS);

      request.signal.addEventListener('abort', () => {
        void cleanup();
      });
    },
    cancel() {
      void cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
});
