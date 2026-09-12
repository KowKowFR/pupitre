import {
  decrypt,
  targetPreflightJobDataSchema,
  usableRuntimes,
  type TargetPreflightJobResult,
} from '@pupitre/core';
import { runPreflight, type SshTarget } from '@pupitre/core/ssh';
import { getTargetSecret, logAudit, savePreflightResult } from '@pupitre/db';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';

/**
 * Preflight d'une machine cible.
 *
 * C'est le seul endroit du projet où un credential est déchiffré, et il ne
 * quitte jamais la portée de cette fonction : ni retour, ni audit, ni log.
 */
export async function handleTargetPreflight(
  job: Job<unknown, TargetPreflightJobResult>,
): Promise<TargetPreflightJobResult> {
  const data = targetPreflightJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, jobName: job.name, targetId: data.targetId });

  const record = await getTargetSecret(data.targetId);
  if (!record) {
    throw new Error(`Cible « ${data.targetId} » introuvable`);
  }

  const { target, encryptedCredential } = record;
  log.info({ host: target.host, port: target.port }, 'preflight démarré');

  const secret = decrypt(encryptedCredential);
  const sshTarget: SshTarget = {
    host: target.host,
    port: target.port,
    username: target.sshUser,
    sudoMethod: target.sudoMethod,
    credentials:
      target.authMethod === 'key'
        ? { authMethod: 'key', privateKey: secret }
        : { authMethod: 'password', password: secret },
  };

  const report = await runPreflight(sshTarget, log);
  await savePreflightResult(data.targetId, report);

  const runtimes = usableRuntimes(report.runtimes);

  log.info(
    {
      host: target.host,
      status: report.status,
      runtimes,
      latencyMs: report.latencyMs,
      failedChecks: report.checks.filter((check) => check.status === 'failed').map((c) => c.key),
    },
    'preflight terminé',
  );

  await logAudit({
    actorId: data.actorId,
    action: 'target.preflight.completed',
    resourceType: 'target',
    resourceId: data.targetId,
    // Le rapport complet, sans le moindre credential : `runPreflight` ne
    // manipule que des sorties de commandes.
    after: {
      host: target.host,
      status: report.status,
      reachable: report.reachable,
      latencyMs: report.latencyMs,
      os: report.os.prettyName ?? report.os.uname,
      sudo: report.sudo,
      runtimes: report.runtimes,
      tools: report.tools,
      disk: report.disk,
      memory: report.memory,
      checks: report.checks.map((check) => ({
        key: check.key,
        status: check.status,
        detail: check.detail,
        error: check.error,
      })),
    },
    ip: data.ip,
  });

  return {
    targetId: data.targetId,
    status: report.status,
    reachable: report.reachable,
    runtimes,
    checkedAt: report.checkedAt,
  };
}
