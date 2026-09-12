import { SCHEDULED_JOB_TYPES, describeCron, fromCron } from '@pupitre/core';
import {
  createScheduledJob,
  createScheduledJobSchema,
  getAppSettingsValue,
  getScheduledJobByKey,
  lastRunsByJob,
  listScheduledJobs,
  logAudit,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { ConflictError } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { schedulerStates, syncScheduler } from '@/lib/schedules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Tâches planifiées.
 *
 * `/api/jobs` désigne les tâches **planifiées** — des lignes de `scheduled_jobs`
 * avec un cycle de vie CRUD. L'état d'une tâche BullMQ ponctuelle, lui, se lit
 * sur `/api/queue/jobs/:id`.
 */

export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'job:read');

  const [rows, states, lastRuns, settings] = await Promise.all([
    listScheduledJobs(),
    schedulerStates(),
    lastRunsByJob(),
    getAppSettingsValue(),
  ]);

  const items = rows.map((row) => {
    const definition = SCHEDULED_JOB_TYPES[row.type];
    const state = states.get(row.key);
    const lastRun = lastRuns.get(row.id);
    const timeZone = row.timezone;

    return {
      id: row.id,
      key: row.key,
      type: row.type,
      jobName: definition.jobName,
      label: definition.label,
      description: definition.description,
      neverDoes: definition.neverDoes,
      cron: row.cron,
      cronDescription: describeCron(row.cron, { timeZone }),
      // `null` quand l'expression n'a pas d'équivalent simplifié : l'écran
      // bascule alors en mode expert plutôt que d'afficher une approximation.
      schedule: fromCron(row.cron),
      timeZone,
      // Fuseau réellement mémorisé par BullMQ : un écart avec `timeZone` dit que
      // le scheduler date d'avant la modification, et sera corrigé au prochain
      // upsert. Le masquer laisserait croire à une heure qui n'est pas la bonne.
      schedulerTimeZone: state?.timeZone ?? null,
      payload: row.payload,
      enabled: row.enabled,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      nextRunAt: state?.nextRunAt ?? null,
      // `false` sur une tâche active signale un écart entre la base et Redis :
      // le prochain démarrage du worker le corrigera, et l'UI le montre.
      installed: state?.installed ?? false,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            status: lastRun.status,
            manual: lastRun.manual,
            startedAt: lastRun.startedAt.toISOString(),
            finishedAt: lastRun.finishedAt?.toISOString() ?? null,
            error: lastRun.error,
          }
        : null,
      createdAt: row.createdAt.toISOString(),
    };
  });

  // `defaultTimeZone` est celui des paramètres d'instance : le pré-remplissage
  // du formulaire, pas le fuseau d'une tâche en particulier.
  return NextResponse.json({
    items,
    total: items.length,
    defaultTimeZone: settings.timezone,
  });
});

export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'job:manage');
  const input = await readJsonBody(request, createScheduledJobSchema);

  const key = input.key ?? SCHEDULED_JOB_TYPES[input.type].defaultKey;
  if (await getScheduledJobByKey(key)) {
    throw new ConflictError(`Une tâche planifiée « ${key} » existe déjà`);
  }

  const row = await createScheduledJob({ ...input, key });
  await syncScheduler(row);

  await logAudit({
    actorId: auth.userId,
    action: 'schedule.created',
    resourceType: 'scheduled_job',
    resourceId: row.id,
    after: {
      key: row.key,
      type: row.type,
      cron: row.cron,
      timezone: row.timezone,
      enabled: row.enabled,
    },
    ip: auth.ip,
  });

  return NextResponse.json(
    {
      id: row.id,
      key: row.key,
      type: row.type,
      cron: row.cron,
      cronDescription: describeCron(row.cron, { timeZone: row.timezone }),
      // `null` quand l'expression n'a pas d'équivalent simplifié : l'écran
      // bascule alors en mode expert plutôt que d'afficher une approximation.
      schedule: fromCron(row.cron),
      timeZone: row.timezone,
      payload: row.payload,
      enabled: row.enabled,
    },
    { status: 201 },
  );
});
