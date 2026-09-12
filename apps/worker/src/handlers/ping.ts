import { pingJobDataSchema, type PingJobResult } from '@pupitre/core';
import { logAudit } from '@pupitre/db';
import type { Job } from 'bullmq';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * Tâche de fumée du jalon 1 : elle prouve que la chaîne
 * route HTTP → BullMQ → worker → Postgres est complète.
 */
export async function handlePing(job: Job<unknown, PingJobResult>): Promise<PingJobResult> {
  const data = pingJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, jobName: job.name });

  log.info({ message: data.message, requestedAt: data.requestedAt }, 'ping reçu');

  const auditLog = await logAudit({
    actorId: data.actorId,
    action: 'ping.handled',
    resourceType: 'job',
    resourceId: job.id ?? null,
    after: {
      queue: job.queueName,
      message: data.message,
      requestedAt: data.requestedAt,
      workerId: env.WORKER_ID,
    },
    ip: data.ip,
  });

  log.info({ auditLogId: auditLog?.id ?? null }, 'ping journalisé dans audit_logs');

  return {
    ok: true,
    message: data.message,
    handledAt: new Date().toISOString(),
    auditLogId: auditLog?.id ?? null,
    workerId: env.WORKER_ID,
  };
}
