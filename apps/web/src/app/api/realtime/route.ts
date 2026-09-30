import { CHAT_DEFAULT_CHANNEL, PRESENCE_TOUCH_MS, type RealtimeEvent } from '@pupitre/core';
import { countUnreadChat, countUnreadChatMentions } from '@pupitre/db';
import { apiRoute } from '@/lib/http';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/rbac';
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

/** Toutes les quatre respirations (~100 s), la session est relue : révoquée, le flux se ferme. */
const SESSION_RECHECK_EVERY = 4;

/**
 * Le flux temps réel d'un onglet : présence, discussion, signaux des écrans.
 *
 * Ouvert, il compte comme une présence ; fermé, il la retire. Le premier
 * message (`hello`) donne l'état complet — qui est là, combien de messages
 * non lus — puis ne viennent que des changements. Un onglet qui se reconnecte
 * repart donc d'un état juste, sans rien avoir à rejouer.
 *
 * Ce qu'un événement révèle suit les permissions de la session : l'activité
 * du journal ne part qu'à qui peut lire le journal. Les signaux d'écran, eux,
 * ne portent qu'un sujet — la page se relit avec ses propres droits.
 */
export const GET = apiRoute(async (request) => {
  const auth = await requireSession(request);
  const canReadAudit = auth.can('audit:read');
  const encoder = new TextEncoder();

  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  /** Fermeture unique : l'abandon du client et `cancel()` arrivent souvent tous les deux. */
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
          // Déjà fermé côté client.
        }
        await presenceDisconnected(auth.userId).catch((error: unknown) => {
          logger.warn({ err: error }, 'présence non retirée');
        });
      };

      // S'abonner avant de compter la présence : sa propre arrivée fait partie
      // de ce que l'onglet doit voir.
      unsubscribe = onRealtime((event: RealtimeEvent) => {
        if (event.type === 'activity' && !canReadAudit) return;
        send(event.type, event);
      });

      try {
        await presenceConnected(auth.userId);
        const [presence, unread, mentions, choice] = await Promise.all([
          presenceSnapshot(),
          countUnreadChat(auth.userId, CHAT_DEFAULT_CHANNEL),
          countUnreadChatMentions(auth.userId, CHAT_DEFAULT_CHANNEL),
          getPresenceChoice(auth.userId),
        ]);
        send('hello', { me: auth.userId, presence, unread, mentions, choice });
      } catch (error) {
        logger.error({ err: error }, 'flux temps réel indisponible');
        send('error', { code: 'unavailable' });
        await cleanup();
        return;
      }

      let beats = 0;
      heartbeat = setInterval(() => {
        beats += 1;
        // Un reverse proxy coupe une connexion muette : le commentaire la garde ouverte.
        write(': heartbeat\n\n');
        void presenceTouched(auth.userId).catch(() => undefined);
        if (beats % SESSION_RECHECK_EVERY === 0) {
          requireSession(request).catch(() => {
            send('bye', { reason: 'session' });
            void cleanup();
          });
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
