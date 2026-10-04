import { describeCron, fromCron, scheduledJobTypes } from '@pupitre/core';
import {
  deleteScheduledJob,
  getScheduledJob,
  listScheduledJobRuns,
  logAudit,
  updateScheduledJob,
  updateScheduledJobSchema,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentLanguage } from '@/i18n/server';
import { jobs as messages } from '@/i18n/messages/jobs';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { removeScheduler, schedulerStates, syncScheduler } from '@/lib/schedules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

type Context = { params: Promise<{ id: string }> };

export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'job:read');
  const { id } = paramsSchema.parse(await context.params);

  const row = await getScheduledJob(id);
  if (!row) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const [runs, states] = await Promise.all([listScheduledJobRuns(id, 20), schedulerStates()]);
  const language = await currentLanguage();
  const definition = scheduledJobTypes(language)[row.type];
  const timeZone = row.timezone;

  return NextResponse.json({
    id: row.id,
    key: row.key,
    type: row.type,
    jobName: definition.jobName,
    label: definition.label,
    description: definition.description,
    neverDoes: definition.neverDoes,
    cron: row.cron,
    cronDescription: describeCron(row.cron, { locale: language, timeZone }),
    schedule: fromCron(row.cron),
    timeZone,
    // The time zone really stored by BullMQ, to make the gap visible.
    schedulerTimeZone: states.get(row.key)?.timeZone ?? null,
    payload: row.payload,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: states.get(row.key)?.nextRunAt ?? null,
    installed: states.get(row.key)?.installed ?? false,
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      manual: run.manual,
      summary: run.summary,
      error: run.error,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      durationMs: run.finishedAt
        ? run.finishedAt.getTime() - run.startedAt.getTime()
        : null,
    })),
  });
});

export const PATCH = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'job:manage');
  const { id } = paramsSchema.parse(await context.params);
  const patch = await readJsonBody(request, updateScheduledJobSchema);

  const before = await getScheduledJob(id);
  if (!before) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const row = await updateScheduledJob(id, patch);
  if (!row) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  // The database first, Redis next: see `lib/schedules.ts`. A time zone change goes
  // through the same `upsertJobScheduler`, which recomputes the next occurrence:
  // there is nothing to remove then reinstall by hand.
  await syncScheduler(row);

  await logAudit({
    actorId: auth.userId,
    action: row.enabled === before.enabled ? 'schedule.updated' : row.enabled ? 'schedule.enabled' : 'schedule.disabled',
    resourceType: 'scheduled_job',
    resourceId: row.id,
    before: {
      cron: before.cron,
      timezone: before.timezone,
      enabled: before.enabled,
      payload: before.payload,
    },
    after: {
      key: row.key,
      cron: row.cron,
      timezone: row.timezone,
      enabled: row.enabled,
      payload: row.payload,
    },
    ip: auth.ip,
  });

  return NextResponse.json({
    id: row.id,
    key: row.key,
    type: row.type,
    cron: row.cron,
    cronDescription: describeCron(row.cron, {
      locale: await currentLanguage(),
      timeZone: row.timezone,
    }),
    schedule: fromCron(row.cron),
    timeZone: row.timezone,
    payload: row.payload,
    enabled: row.enabled,
  });
});

export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'job:manage');
  const { id } = paramsSchema.parse(await context.params);

  const row = await deleteScheduledJob(id);
  if (!row) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  await removeScheduler(row.key);

  await logAudit({
    actorId: auth.userId,
    action: 'schedule.deleted',
    resourceType: 'scheduled_job',
    resourceId: row.id,
    before: { key: row.key, type: row.type, cron: row.cron, timezone: row.timezone },
    ip: auth.ip,
  });

  return new NextResponse(null, { status: 204 });
});
