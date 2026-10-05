import { SCHEDULED_JOB_TYPES, describeCron, fromCron, scheduledJobTypes } from '@pupitre/core';
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
import { currentLanguage } from '@/i18n/server';
import { jobs as messages } from '@/i18n/messages/jobs';
import { ConflictError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { schedulerStates, syncScheduler } from '@/lib/schedules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Scheduled tasks.
 *
 * `/api/jobs` designates the **scheduled** tasks — rows of `scheduled_jobs` with
 * a CRUD life cycle. A one-off BullMQ job's state, for its part, is read on
 * `/api/queue/jobs/:id`.
 */

export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'job:read');

  const language = await currentLanguage();
  const [rows, states, lastRuns, settings] = await Promise.all([
    listScheduledJobs(),
    schedulerStates(),
    lastRunsByJob(),
    getAppSettingsValue(),
  ]);
  const types = scheduledJobTypes(language);

  const items = rows.map((row) => {
    const definition = types[row.type];
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
      cronDescription: describeCron(row.cron, { locale: language, timeZone }),
      // `null` when the expression has no simplified equivalent: the screen then
      // switches to expert mode rather than show an approximation.
      schedule: fromCron(row.cron),
      timeZone,
      // The time zone really stored by BullMQ: a gap with `timeZone` says the scheduler
      // predates the change, and will be fixed at the next upsert. Hiding it would
      // suggest a time that is not the right one.
      schedulerTimeZone: state?.timeZone ?? null,
      payload: row.payload,
      enabled: row.enabled,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      nextRunAt: state?.nextRunAt ?? null,
      // `false` on an active task signals a gap between the database and Redis: the
      // worker's next start will fix it, and the UI shows it.
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

  // `defaultTimeZone` is the instance settings': the form's prefill, not a
  // particular task's time zone.
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
    throw new ConflictError(msg(messages, 'error.keyTaken', { key }));
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
      cronDescription: describeCron(row.cron, {
        locale: await currentLanguage(),
        timeZone: row.timezone,
      }),
      // `null` when the expression has no simplified equivalent: the screen then
      // switches to expert mode rather than show an approximation.
      schedule: fromCron(row.cron),
      timeZone: row.timezone,
      payload: row.payload,
      enabled: row.enabled,
    },
    { status: 201 },
  );
});
