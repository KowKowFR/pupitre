import { workloadChannel, workloadMessageSchema } from '@pupitre/core';
import { getTarget } from '@pupitre/db';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { getEnv } from '@/lib/env';
import { targets as messages } from '@/i18n/messages/targets';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { logger } from '@/lib/logger';
import { requirePermission } from '@/lib/rbac';
import { claimWorkloadRun } from '@/lib/workload-runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const HEARTBEAT_MS = 15_000;

/**
 * Progression des actions sur les charges d'une cible, en SSE.
 *
 * Même dispositif que les logs de déploiement, mais sans historique à relire :
 * une suppression ou une mise à jour n'a pas de passé persisté, et il n'y a
 * donc rien à rejouer avant de passer en direct. Le flux reste ouvert d'une
 * action à l'autre — c'est un canal de cible, pas de tâche.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'workload:read');
  const { id } = paramsSchema.parse(await context.params);

  // `?run=` : le flux d'une seule exécution (journal, commande), réservé à
  // qui l'a ouverte. Sans lui, le flux de la cible — sans les sorties privées.
  const runParam = new URL(request.url).searchParams.get('run');
  const run = runParam ? z.string().uuid().parse(runParam) : null;
  if (run && !(await claimWorkloadRun(run, auth.userId))) {
    throw new HttpError(403, 'run_not_owned', msg(messages, 'error.runNotOwned'));
  }

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const channel = workloadChannel(id);
  const encoder = new TextEncoder();
  // Connexion dédiée : abonnée, une connexion Redis n'accepte plus rien d'autre.
  const subscriber = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });

  let heartbeat: NodeJS.Timeout | null = null;
  let closed = false;

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    try {
      await subscriber.unsubscribe(channel);
    } catch {
      // La connexion peut déjà être tombée : rien à sauver.
    }
    subscriber.disconnect();
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          void cleanup();
        }
      };

      subscriber.on('message', (_channel, raw: string) => {
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          return;
        }
        const parsed = workloadMessageSchema.safeParse(payload);
        if (!parsed.success) return;
        // Une sortie d'exécution ne va qu'au flux de cette exécution.
        const messageRun = parsed.data.payload.run ?? null;
        if (messageRun !== run) return;
        send(parsed.data.kind, parsed.data.payload);
      });

      subscriber.on('error', (error) => {
        logger.warn({ err: error, channel }, 'connexion Redis du flux SSE en erreur');
      });

      try {
        await subscriber.subscribe(channel);
      } catch (error) {
        logger.error({ err: error, channel }, 'abonnement Redis impossible');
        send('error', { message: 'flux indisponible' });
        await cleanup();
        controller.close();
        return;
      }

      send('ready', { targetId: id, channel });

      // Battement de cœur : un reverse proxy coupe une connexion muette.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          void cleanup();
        }
      }, HEARTBEAT_MS);

      request.signal.addEventListener('abort', () => {
        void cleanup().then(() => {
          try {
            controller.close();
          } catch {
            // Déjà fermé.
          }
        });
      });
    },

    async cancel() {
      await cleanup();
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
