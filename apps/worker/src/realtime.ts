import {
  REALTIME_CHANNEL,
  liveTopicOfJob,
  liveTopicOfResource,
  realtimeEventSchema,
  type RealtimeEvent,
} from '@pupitre/core';
import { setNamedAuditObserver } from '@pupitre/db';
import type { Job, Worker } from 'bullmq';
import { logger } from './logger.js';
import { getPublisher } from './redis.js';

/**
 * Le worker, côté temps réel : il dit aux écrans ouverts que quelque chose a
 * bougé. Il ne pousse jamais de données — un signal, un sujet, et c'est la
 * page qui se relit avec ses propres permissions.
 *
 * Publier ne doit jamais gêner le travail : une erreur Redis ici est écrite
 * dans les logs, et le déploiement continue.
 */

function publish(event: RealtimeEvent): void {
  const parsed = realtimeEventSchema.safeParse(event);
  if (!parsed.success) return;
  getPublisher()
    .publish(REALTIME_CHANNEL, JSON.stringify(parsed.data))
    .catch((error: unknown) => {
      logger.warn({ err: error, type: event.type }, 'événement temps réel non publié');
    });
}

function onJob(job: Job | undefined, phase: 'active' | 'settled'): void {
  if (!job) return;
  const topic = liveTopicOfJob(job.name);
  if (!topic) return;
  // Le départ n'intéresse que ce qui s'affiche « en cours » : un déploiement.
  if (phase === 'active' && topic !== 'deployments') return;
  publish({ type: 'live', topic, source: 'job', detail: job.name.slice(0, 120) });
}

/** Branche les workers BullMQ sur le canal temps réel. */
export function installRealtimeJobEvents(workers: readonly Worker[]): void {
  for (const worker of workers) {
    worker.on('active', (job) => onJob(job, 'active'));
    worker.on('completed', (job) => onJob(job, 'settled'));
    worker.on('failed', (job) => onJob(job, 'settled'));
  }
}

/**
 * Chaque ligne du journal écrite par le worker devient un signal : l'activité
 * pour qui peut lire le journal, et le sujet pour les écrans concernés.
 */
export function installRealtimeAudit(): void {
  setNamedAuditObserver('realtime', (row) => {
    publish({
      type: 'activity',
      id: String(row.id),
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId ?? null,
      actorId: row.actorId ?? null,
      at: row.createdAt.toISOString(),
    });
    const topic = liveTopicOfResource(row.resourceType);
    if (topic) publish({ type: 'live', topic, source: 'audit', detail: row.action.slice(0, 120) });
  });
}
