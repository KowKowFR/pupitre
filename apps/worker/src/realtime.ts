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
 * The worker, real-time side: it tells open screens that something moved. It
 * never pushes data — a signal, a topic, and it is the page that reads itself
 * again with its own permissions.
 *
 * Publishing must never hinder the work: a Redis error here is written to the
 * logs, and the deployment goes on.
 */

function publish(event: RealtimeEvent): void {
  const parsed = realtimeEventSchema.safeParse(event);
  if (!parsed.success) return;
  getPublisher()
    .publish(REALTIME_CHANNEL, JSON.stringify(parsed.data))
    .catch((error: unknown) => {
      logger.warn({ err: error, type: event.type }, 'real-time event not published');
    });
}

function onJob(job: Job | undefined, phase: 'active' | 'settled'): void {
  if (!job) return;
  const topic = liveTopicOfJob(job.name);
  if (!topic) return;
  // The start only interests what shows "in progress": a deployment.
  if (phase === 'active' && topic !== 'deployments') return;
  publish({ type: 'live', topic, source: 'job', detail: job.name.slice(0, 120) });
}

/** Plugs the BullMQ workers into the real-time channel. */
export function installRealtimeJobEvents(workers: readonly Worker[]): void {
  for (const worker of workers) {
    worker.on('active', (job) => onJob(job, 'active'));
    worker.on('completed', (job) => onJob(job, 'settled'));
    worker.on('failed', (job) => onJob(job, 'settled'));
  }
}

/**
 * Each log line written by the worker becomes a signal: the activity for whoever
 * can read the log, and the topic for the screens concerned.
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
