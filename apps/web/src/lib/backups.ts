import 'server-only';
import {
  BACKUPS_QUEUE,
  SCHEDULED_JOB_TYPES,
  describeBackupDestination,
  type BackupMode,
  type ScheduledJobType,
} from '@pupitre/core';
import {
  createScheduledJob,
  lastRestoreOf,
  listApplications,
  listBackupPolicies,
  listBackups,
  listLiveDeployments,
  listScheduledJobs,
  listTargets,
  updateScheduledJob,
  type BackupDestinationView,
  type BackupRow,
  type ScheduledJob,
} from '@pupitre/db';
import { Queue } from 'bullmq';
import { getRedis } from './redis';
import { schedulerStates, syncScheduler } from './schedules';

/**
 * What the backup routes share: the queue, the scheduled tasks to create at the
 * first need, and the shape in which a backup or a destination leaves the API.
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
 * Enabling an automatic backup without a task existing to run it would be a
 * hollow promise: the task is created at the first need, with its default
 * cadence — changeable afterwards in "Tasks", like the others. A task disabled by
 * hand is **re-enabled**: one just asked for it to run.
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

/** Where an application runs right now — where it can be restored. */
export type LiveTargetView = { id: string; name: string; stopped: boolean };

export type LastRestoreView = {
  ok: boolean;
  at: string;
  actorName: string | null;
  error: string | null;
};

export function lastRestoreView(
  restore: Awaited<ReturnType<typeof lastRestoreOf>>,
): LastRestoreView | null {
  if (!restore) return null;
  return {
    ok: restore.ok,
    at: restore.at.toISOString(),
    actorName: restore.actorName,
    error: typeof restore.after.error === 'string' ? restore.after.error : null,
  };
}

export type ApplicationBackupsView = {
  /** `null`: the application was deleted, its backups stayed. */
  id: string | null;
  slug: string;
  name: string;
  policy: { enabled: boolean; beforeDeploy: boolean; mode: BackupMode } | null;
  targets: LiveTargetView[];
  items: BackupView[];
  lastRestore: LastRestoreView | null;
};

/**
 * The number of backups read for the overview. Retention keeps about twenty per
 * application and the failures go after a month: the bound is only there so that
 * an oversized instance does not return an oversized page.
 */
const OVERVIEW_LIMIT = 2000;

/**
 * All the applications that have a backup or a policy, each with its history and
 * the targets where it runs. A deleted application's backups are there too,
 * grouped by its name: they are still on the destination, and this is where they
 * are found.
 */
export async function applicationBackupsOverview(): Promise<{
  applications: ApplicationBackupsView[];
  targetNames: Record<string, string>;
}> {
  const [rows, applications, policies, live, targets] = await Promise.all([
    listBackups({ kind: 'application', limit: OVERVIEW_LIMIT }),
    listApplications(),
    listBackupPolicies(),
    listLiveDeployments(),
    listTargets(),
  ]);
  const nameOf = new Map(targets.map((target) => [target.id, target.name]));

  const byApplication = new Map<string, BackupView[]>();
  const orphans = new Map<string, BackupView[]>();
  for (const row of rows) {
    const view = backupView(row);
    const [bucket, key] = row.applicationId
      ? [byApplication, row.applicationId]
      : [orphans, row.applicationSlug ?? '?'];
    const items = bucket.get(key);
    if (items) items.push(view);
    else bucket.set(key, [view]);
  }

  const listed = applications.filter(
    (application) => policies.has(application.id) || byApplication.has(application.id),
  );
  const restores = await Promise.all(listed.map((application) => lastRestoreOf(application.id)));

  const views: ApplicationBackupsView[] = listed.map((application, index) => {
    const policy = policies.get(application.id);
    return {
      id: application.id,
      slug: application.slug,
      name: application.name,
      policy: policy
        ? { enabled: policy.enabled, beforeDeploy: policy.beforeDeploy, mode: policy.mode }
        : null,
      targets: live
        .filter((couple) => couple.applicationId === application.id && couple.inService)
        .map((couple) => ({
          id: couple.targetId,
          name: nameOf.get(couple.targetId) ?? couple.targetId,
          stopped: couple.inService?.stoppedAt !== null,
        })),
      items: byApplication.get(application.id) ?? [],
      lastRestore: lastRestoreView(restores[index] ?? null),
    };
  });
  for (const [slug, items] of [...orphans].sort(([a], [b]) => a.localeCompare(b))) {
    views.push({
      id: null,
      slug,
      name: slug,
      policy: null,
      targets: [],
      items,
      lastRestore: null,
    });
  }

  // The names of the targets where a backup was taken — not the others.
  const referenced = new Set(rows.map((row) => row.targetId).filter((id) => id !== null));
  const targetNames = Object.fromEntries(
    [...referenced].map((id) => [id, nameOf.get(id) ?? id] as const),
  );
  return { applications: views, targetNames };
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
