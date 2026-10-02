import {
  deployChannel,
  deployMessageSchema,
  isTerminal,
  type DeployMessage,
  type DeploymentStatus,
} from '@pupitre/core';
import { getDeploymentSummary, readDeploymentLog } from '@pupitre/db';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { getEnv } from '@/lib/env';
import { deployments as messages } from '@/i18n/messages/deployments';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { logger } from '@/lib/logger';
import { requireApplicationScope, requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const HEARTBEAT_MS = 15_000;

/**
 * Flux SSE des logs d'un déploiement.
 *
 * L'ordre des opérations est ce qui garantit l'absence de trou :
 *
 *   1. on s'abonne à Redis **avant** de lire l'historique ;
 *   2. les messages qui arrivent pendant la lecture sont mis de côté ;
 *   3. on envoie l'historique persisté ;
 *   4. on vide la file d'attente, puis on passe en direct.
 *
 * S'abonner après la lecture perdrait tout ce qui se produit entre les deux.
 * Lire l'historique après avoir vidé la file le doublonnerait.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:read', { applicationScoped: true });
  const { id } = paramsSchema.parse(await context.params);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(msg(messages, 'error.notFound', { id }));
  await requireApplicationScope(request, auth, deployment.applicationId);

  const channel = deployChannel(id);
  const encoder = new TextEncoder();
  // Connexion dédiée : en mode `subscribe`, une connexion Redis n'accepte plus
  // d'autres commandes. Elle est fermée à la déconnexion du client.
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
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          void cleanup();
        }
      };

      /** Empêche un doublon entre historique relu et message reçu en direct. */
      const seen = new Set<string>();
      const fingerprint = (message: DeployMessage): string =>
        message.kind === 'log'
          ? `${message.payload.ts}|${message.payload.step}|${message.payload.line}`
          : `event|${message.payload.ts}|${message.payload.key}|${message.payload.status}`;

      const forward = (raw: string) => {
        const parsed = deployMessageSchema.safeParse(JSON.parse(raw) as unknown);
        if (!parsed.success) return;

        const key = fingerprint(parsed.data);
        if (seen.has(key)) return;
        seen.add(key);

        send(parsed.data.kind, parsed.data.payload);

        // Le déploiement est terminé : on ferme proprement plutôt que de
        // laisser le client attendre indéfiniment.
        if (
          parsed.data.kind === 'event' &&
          parsed.data.payload.type === 'deployment' &&
          isTerminal(parsed.data.payload.status as DeploymentStatus)
        ) {
          send('end', { status: parsed.data.payload.status });
          void cleanup().then(() => {
            try {
              controller.close();
            } catch {
              // Déjà fermé côté client.
            }
          });
        }
      };

      // 1. Abonnement d'abord.
      const pending: string[] = [];
      let live = false;
      subscriber.on('message', (_channel, raw: string) => {
        if (live) forward(raw);
        else pending.push(raw);
      });
      subscriber.on('error', (error) => {
        logger.warn({ err: error, channel }, 'connexion Redis du flux SSE en erreur');
      });

      try {
        await subscriber.subscribe(channel);
      } catch (error) {
        logger.error({ err: error, channel }, 'abonnement Redis impossible');
        send('error', { message: 'flux de logs indisponible' });
        await cleanup();
        controller.close();
        return;
      }

      // 2. Historique persisté.
      send('status', {
        id: deployment.id,
        status: deployment.status,
        url: deployment.url,
        failedStep: deployment.failedStep,
      });

      const history = await readDeploymentLog(id);
      for (const entry of history) {
        for (const rawLine of entry.log.split('\n')) {
          if (rawLine.trim().length === 0) continue;
          try {
            const parsed = deployMessageSchema.safeParse({
              kind: 'log',
              payload: JSON.parse(rawLine) as unknown,
            });
            if (!parsed.success) continue;

            // Même déduplication que le direct : les deux chemins doivent
            // produire exactement la même suite de lignes, sans quoi un
            // rafraîchissement afficherait autre chose que le flux initial.
            const key = fingerprint(parsed.data);
            if (seen.has(key)) continue;
            seen.add(key);
            send('log', parsed.data.payload);
          } catch {
            // Ligne tronquée par un arrêt brutal : on la saute.
          }
        }
      }
      send('replayed', { lines: seen.size });

      // 3. On vide ce qui est arrivé pendant la relecture, puis direct.
      live = true;
      for (const raw of pending) forward(raw);
      pending.length = 0;

      // Un déploiement déjà terminé n'émettra plus rien.
      if (isTerminal(deployment.status)) {
        send('end', { status: deployment.status });
        await cleanup();
        controller.close();
        return;
      }

      // 4. Battement de cœur : un reverse proxy coupe une connexion muette.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          void cleanup();
        }
      }, HEARTBEAT_MS);

      // Déconnexion du client : on relâche la connexion Redis.
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
      // Désactive la mise en tampon de nginx, qui retiendrait le flux.
      'x-accel-buffering': 'no',
    },
  });
});
