import 'server-only';
import {
  BACKUPS_QUEUE,
  SCHEDULED_JOB_TYPES,
  describeBackupDestination,
  type ScheduledJobType,
} from '@pupitre/core';
import {
  createScheduledJob,
  listScheduledJobs,
  updateScheduledJob,
  type BackupDestinationView,
  type BackupRow,
  type ScheduledJob,
} from '@pupitre/db';
import { Queue } from 'bullmq';
import { getRedis } from './redis';
import { schedulerStates, syncScheduler } from './schedules';

/**
 * Ce que les routes de sauvegarde partagent : la file, les tâches planifiées
 * qu'il faut créer au premier besoin, et la forme sous laquelle une sauvegarde
 * ou une destination sort de l'API.
 */

declare global {
  var __tpBackupsQueue: Queue | undefined;
}

export function getBackupsQueue(): Queue {
  globalThis.__tpBackupsQueue ??= new Queue(BACKUPS_QUEUE, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 7 * 24 * 3600, count: 500 },
      removeOnFail: { age: 30 * 24 * 3600, count: 500 },
    },
  });
  return globalThis.__tpBackupsQueue;
}

type BackupScheduleType = Extract<ScheduledJobType, 'backup' | 'panel_backup'>;

async function scheduleOf(type: BackupScheduleType): Promise<ScheduledJob | null> {
  const jobs = await listScheduledJobs();
  return jobs.find((job) => job.type === type) ?? null;
}

/**
 * Activer une sauvegarde automatique sans qu'il existe de tâche pour la faire
 * tourner serait une promesse creuse : la tâche est créée au premier besoin,
 * avec sa cadence par défaut — modifiable ensuite dans « Tâches », comme les
 * autres. Une tâche désactivée à la main est **réactivée** : on vient de
 * demander qu'elle tourne.
 */
export async function ensureBackupSchedule(type: BackupScheduleType): Promise<ScheduledJob> {
  const existing = await scheduleOf(type);
  if (existing) {
    if (existing.enabled) return existing;
    const updated = (await updateScheduledJob(existing.id, { enabled: true })) ?? existing;
    await syncScheduler(updated);
    return updated;
  }
  const created = await createScheduledJob({
    key: undefined,
    type,
    cron: SCHEDULED_JOB_TYPES[type].defaultCron,
    timezone: undefined,
    payload: {},
    enabled: true,
  });
  await syncScheduler(created);
  return created;
}

export async function disableBackupSchedule(type: BackupScheduleType): Promise<void> {
  const existing = await scheduleOf(type);
  if (!existing?.enabled) return;
  const updated = await updateScheduledJob(existing.id, { enabled: false });
  if (updated) await syncScheduler(updated);
}

export type BackupScheduleView = {
  id: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  nextRunAt: string | null;
} | null;

export async function backupScheduleView(type: BackupScheduleType): Promise<BackupScheduleView> {
  const job = await scheduleOf(type);
  if (!job) return null;
  const states = await schedulerStates();
  return {
    id: job.id,
    enabled: job.enabled,
    cron: job.cron,
    timezone: job.timezone,
    nextRunAt: states.get(job.key)?.nextRunAt ?? null,
  };
}

export type BackupView = {
  id: string;
  kind: BackupRow['kind'];
  applicationId: string | null;
  applicationSlug: string | null;
  targetId: string | null;
  trigger: BackupRow['trigger'];
  mode: BackupRow['mode'];
  status: BackupRow['status'];
  location: string;
  bytes: number;
  pieces: Array<{ kind: string; label: string; bytes: number }>;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export function backupView(row: BackupRow): BackupView {
  return {
    id: row.id,
    kind: row.kind,
    applicationId: row.applicationId,
    applicationSlug: row.applicationSlug,
    targetId: row.targetId,
    trigger: row.trigger,
    mode: row.mode,
    status: row.status,
    location: row.location,
    bytes: row.bytes,
    pieces: (row.manifest?.pieces ?? []).map((piece) => ({
      kind: piece.kind,
      label:
        piece.kind === 'volume'
          ? `${piece.service} · ${piece.volume}`
          : piece.kind === 'dump'
            ? `${piece.service} · ${piece.engine}`
            : 'pupitre',
      bytes: piece.bytes,
    })),
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export type DestinationView = {
  id: string;
  kind: BackupDestinationView['kind'];
  name: string;
  config: Record<string, unknown>;
  secretFields: string[];
  description: string;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
};

export function destinationView(row: BackupDestinationView): DestinationView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    config: row.config,
    secretFields: row.secretFields,
    description: describeBackupDestination({ kind: row.kind, config: row.config }),
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastCheckError: row.lastCheckError,
  };
}
