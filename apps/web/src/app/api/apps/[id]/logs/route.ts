import {
  APP_LOGS_JOB,
  WATCH_REFRESH_MS,
  WATCH_TTL_SECONDS,
  appLogChannel,
  appLogMessageSchema,
  appLogWatchKey,
  deploymentJobDataSchema,
  isSupervisable,
} from '@pupitre/core';
import { getDeploymentSummary } from '@pupitre/db';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { getEnv } from '@/lib/env';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { logger } from '@/lib/logger';
import { requirePermission } from '@/lib/rbac';
import { getRedis } from '@/lib/redis';
import { getSupervisionQueue } from '@/lib/supervision-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const HEARTBEAT_MS = 15_000;

/**
 * Logs applicatifs en direct.
 *
 * Contrairement aux logs de déploiement, ceux-ci n'ont pas d'historique à
 * rejouer : ce qui est passé est passé, et `docker compose logs` en redonne les
 * dernières lignes à l'ouverture. Il n'y a donc pas de couture à gérer.
 *
 * En revanche il y a une session SSH distante à maintenir en vie, et à couper
 * quand plus personne ne regarde. Cette route est le seul endroit qui sait
 * qu'un spectateur est présent : elle l'écrit dans une clé Redis à durée de vie
 * courte, qu'elle rafraîchit tant que la connexion tient. Le worker la relit et
 * s'arrête quand elle a disparu.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'deployment:read');
  const { id } = paramsSchema.parse(await context.params);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(`Déploiement « ${id} » introuvable`);
  if (!isSupervisable(deployment.status)) {
    throw new ConflictError(
      `Ce déploiement est « ${deployment.status} » : il n'y a pas d'application à suivre.`,
    );
  }

  const channel = appLogChannel(id);
  const watchKey = appLogWatchKey(id);
  const encoder = new TextEncoder();

  // Connexion dédiée : en mode `subscribe`, une connexion Redis n'accepte plus
  // d'autre commande. Celle du panel sert à écrire la clé de présence.
  const subscriber = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  const control = getRedis();

  let heartbeat: NodeJS.Timeout | null = null;
  let presence: NodeJS.Timeout | null = null;
  let closed = false;

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (presence) clearInterval(presence);
    try {
      await subscriber.unsubscribe(channel);
    } catch {
      // La connexion peut déjà être tombée.
    }
    subscriber.disconnect();
    // On ne supprime PAS la clé de présence : un autre onglet regarde peut-être
    // le même flux. Elle expirera d'elle-même si plus personne ne la rafraîchit.
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

      subscriber.on('message', (_channel, raw: string) => {
        try {
          const parsed = appLogMessageSchema.safeParse(JSON.parse(raw) as unknown);
          if (parsed.success) send(parsed.data.kind, parsed.data.payload);
        } catch {
          // Message illisible : on le saute plutôt que de casser le flux.
        }
      });
      subscriber.on('error', (error) => {
        logger.warn({ err: error, channel }, 'connexion Redis du flux applicatif en erreur');
      });

      try {
        await subscriber.subscribe(channel);
      } catch (error) {
        logger.error({ err: error, channel }, 'abonnement au flux applicatif impossible');
        send('error', { message: 'flux indisponible' });
        await cleanup();
        controller.close();
        return;
      }

      // Déclarer la présence AVANT d'enfiler le job : celui-ci refuse de
      // s'ouvrir s'il ne trouve personne à servir.
      await control.set(watchKey, '1', 'EX', WATCH_TTL_SECONDS);

      presence = setInterval(() => {
        control.set(watchKey, '1', 'EX', WATCH_TTL_SECONDS).catch((error: unknown) => {
          logger.warn({ err: error }, 'rafraîchissement de la présence impossible');
        });
      }, WATCH_REFRESH_MS);

      /**
       * `jobId` fixe : plusieurs spectateurs du même déploiement partagent un
       * seul flux, et rouvrir un onglet ne lance pas une seconde session SSH.
       * BullMQ interdit les deux-points dans un identifiant de tâche — d'où le
       * tiret plutôt que le nom de canal.
       *
       * Quand un job du même identifiant existe déjà, BullMQ n'échoue pas : il
       * retourne le job existant sans rien relancer. C'est exactement le
       * comportement voulu pour un second spectateur — mais uniquement tant
       * que le flux tourne. D'où `removeOnComplete`/`removeOnFail` : un flux
       * terminé ne doit laisser aucune trace, sinon son identifiant bloquerait
       * toute réouverture jusqu'à sa péremption. C'est le seul job de la file
       * qui renonce à son historique, et c'est le prix d'un identifiant fixe.
       */
      try {
        await getSupervisionQueue().add(
          APP_LOGS_JOB,
          deploymentJobDataSchema.parse({ deploymentId: id, actorId: null, ip: null }),
          { jobId: `app-logs-${id}`, removeOnComplete: true, removeOnFail: true },
        );
      } catch (error) {
        // Taire cette erreur laisserait le spectateur devant un flux muet.
        logger.error({ err: error, deploymentId: id }, "ouverture du flux impossible");
        send('error', { message: "le flux n'a pas pu être ouvert" });
      }

      send('ready', { deploymentId: id, url: deployment.url, status: deployment.status });

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
