import { pingJobDataSchema, type PingJobResult } from '@pupitre/core';
import { logAudit } from '@pupitre/db';
import type { Job } from 'bullmq';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * The original smoke job: it proves the HTTP route → BullMQ → worker → Postgres
 * chain is complete.
 */
export async function handlePing(job: Job<unknown, PingJobResult>): Promise<PingJobResult> {
  const data = pingJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, jobName: job.name });

  log.info({ message: data.message, requestedAt: data.requestedAt }, 'ping received');

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

  log.info({ auditLogId: auditLog?.id ?? null }, 'ping logged in audit_logs');

  return {
    ok: true,
    message: data.message,
    handledAt: new Date().toISOString(),
    auditLogId: auditLog?.id ?? null,
    workerId: env.WORKER_ID,
  };
}
