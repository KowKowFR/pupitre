import {
  backupApplicationJobDataSchema,
  backupDeleteJobDataSchema,
  backupDestinationCheckJobDataSchema,
  backupPanelJobDataSchema,
  backupRestoreJobDataSchema,
  errorMessage,
  type BackupJobResult,
} from '@pupitre/core';
import {
  deleteBackupRecords,
  getBackup,
  logAudit,
  recordBackupDestinationCheck,
} from '@pupitre/db';
import type { Job } from 'bullmq';
import { backupApplication } from '../backup/application.js';
import { backupPanel } from '../backup/panel.js';
import { restoreApplicationBackup } from '../backup/restore.js';
import { openStore } from '../backup/shared.js';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { workerSay } from '../messages.js';

/**
 * Les tâches de la file `backups` — et le test d'une destination, sur
 * `supervision`. Chacune délègue : la logique vit dans `../backup/`, où le
 * pipeline de déploiement la retrouve pour la sauvegarde préalable.
 */

export async function handleBackupApplication(job: Job): Promise<BackupJobResult> {
  const data = backupApplicationJobDataSchema.parse(job.data);
  const result = await backupApplication({
    applicationId: data.applicationId,
    targetId: data.targetId,
    trigger: data.trigger,
    backupId: data.backupId ?? undefined,
    actorId: data.actorId,
    ip: data.ip,
  });
  return {
    backupId: result.status === 'skipped' ? data.backupId : result.backupId,
    status: result.status,
    bytes: result.status === 'success' ? result.bytes : 0,
    detail:
      result.status === 'success'
        ? null
        : result.status === 'failed'
          ? result.error
          : result.reason,
  };
}

export async function handleBackupPanel(job: Job): Promise<BackupJobResult> {
  const data = backupPanelJobDataSchema.parse(job.data);
  const result = await backupPanel({
    trigger: data.trigger,
    backupId: data.backupId ?? undefined,
    actorId: data.actorId,
    ip: data.ip,
  });
  return {
    backupId: result.backupId,
    status: result.status,
    bytes: result.bytes,
    detail: result.error,
  };
}

export async function handleBackupRestore(job: Job): Promise<BackupJobResult> {
  const data = backupRestoreJobDataSchema.parse(job.data);
  const result = await restoreApplicationBackup(data);
  return { backupId: data.backupId, status: result.status, bytes: 0, detail: result.error };
}

/** Effacer une sauvegarde : de la destination d'abord, de l'index ensuite. */
export async function handleBackupDelete(job: Job): Promise<BackupJobResult> {
  const data = backupDeleteJobDataSchema.parse(job.data);
  const backup = await getBackup(data.backupId);
  if (!backup)
    return {
      backupId: data.backupId,
      status: 'skipped',
      bytes: 0,
      detail: workerSay(await instanceLanguage())('backup.alreadyDeleted'),
    };
  const opened = await openStore(backup.destinationId).catch(() => null);
  let removed = 0;
  try {
    if (opened) removed = await opened.store.removePrefix(`${backup.location}/`);
  } finally {
    await opened?.store.close().catch(() => undefined);
  }
  await deleteBackupRecords([backup.id]);
  await logAudit({
    actorId: data.actorId,
    action: 'backup.deleted',
    resourceType: backup.kind === 'panel' ? 'settings' : 'application',
    resourceId: backup.applicationId,
    after: {
      backupId: backup.id,
      kind: backup.kind,
      application: backup.applicationSlug,
      backupDate: backup.startedAt.toISOString(),
      files: removed,
      destinationGone: opened === null,
    },
    ip: data.ip,
  });
  return { backupId: backup.id, status: 'success', bytes: 0, detail: `${removed} fichier(s)` };
}

/** Écrire, relire, effacer un fichier témoin — et retenir le verdict. */
export async function handleBackupDestinationCheck(
  job: Job,
): Promise<{ ok: boolean; error: string | null }> {
  const data = backupDestinationCheckJobDataSchema.parse(job.data);
  let error: string | null = null;
  const opened = await openStore(data.destinationId).catch((cause: unknown) => {
    error = errorMessage(cause);
    return null;
  });
  try {
    if (opened) await opened.store.check();
  } catch (cause) {
    error = errorMessage(cause);
  } finally {
    await opened?.store.close().catch(() => undefined);
  }
  await recordBackupDestinationCheck(data.destinationId, error);
  logger.info(
    { destinationId: data.destinationId, ok: error === null, error },
    'destination de sauvegarde testée',
  );
  return { ok: error === null, error };
}
