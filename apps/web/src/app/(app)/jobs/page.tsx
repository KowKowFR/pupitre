import {
  SCHEDULED_JOB_TYPES_LIST,
  describeCron,
  fromCron,
  scheduledJobTypes,
  supportedTimeZones,
} from '@pupitre/core';
import {
  getAppSettingsValue,
  lastRunsByJob,
  listScheduledJobRuns,
  listScheduledJobs,
} from '@pupitre/db';
import { LiveRefresh } from '@/components/realtime/live-refresh';
import { currentLanguage } from '@/i18n/server';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { schedulerStates } from '@/lib/schedules';
import { JobsPanel, type JobRow, type JobTypeOption } from './jobs-panel';

export const dynamic = 'force-dynamic';

/**
 * Scheduled tasks.
 *
 * The page reads the database — the source of truth — and completes it with the
 * schedulers' state in Redis, where the next occurrence comes from. A gap between
 * the two is shown rather than hidden: it is operating information.
 */
export default async function JobsPage() {
  const auth = await requirePagePermission('/jobs', 'job:read');
  const language = await currentLanguage();
  const definitions = scheduledJobTypes(language);

  const [rows, states, lastRuns, settings] = await Promise.all([
    listScheduledJobs(),
    schedulerStates(),
    lastRunsByJob(),
    getAppSettingsValue(),
  ]);

  // Two distinct time zones, not to be confused: a task's, which lives in its row,
  // and the instance settings', which only serves to prefill a new task's form.
  const defaultTimeZone = settings.timezone;

  // A list enumerated on the server side: it is the process's ICU that validates
  // the input, and offering the browser a time zone the server would refuse — or
  // the reverse — would produce a choice impossible to save.
  const timeZones = supportedTimeZones();

  const jobs: JobRow[] = await Promise.all(
    rows.map(async (row) => {
      const definition = definitions[row.type];
      const runs = await listScheduledJobRuns(row.id, 10);
      const lastRun = lastRuns.get(row.id) ?? null;

      return {
        id: row.id,
        key: row.key,
        type: row.type,
        jobName: definition.jobName,
        label: definition.label,
        description: definition.description,
        neverDoes: definition.neverDoes,
        cron: row.cron,
        cronDescription: describeCron(row.cron, {
          locale: language,
          timeZone: row.timezone,
        }),
        schedule: fromCron(row.cron),
        timeZone: row.timezone,
        // `null` on a scheduler installed before migration `0009`, or absent from Redis.
        // Different from the row's time zone = the displayed time is not yet the one at
        // which BullMQ will fire.
        schedulerTimeZone: states.get(row.key)?.timeZone ?? null,
        enabled: row.enabled,
        installed: states.get(row.key)?.installed ?? false,
        lastRunAt: row.lastRunAt?.toISOString() ?? null,
        nextRunAt: states.get(row.key)?.nextRunAt ?? null,
        lastRun: lastRun
          ? {
              id: lastRun.id,
              status: lastRun.status,
              manual: lastRun.manual,
              summary: lastRun.summary,
              error: lastRun.error,
              startedAt: lastRun.startedAt.toISOString(),
              finishedAt: lastRun.finishedAt?.toISOString() ?? null,
              durationMs: lastRun.finishedAt
                ? lastRun.finishedAt.getTime() - lastRun.startedAt.getTime()
                : null,
            }
          : null,
        runs: runs.map((run) => ({
          id: run.id,
          status: run.status,
          manual: run.manual,
          summary: run.summary,
          error: run.error,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
          durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
        })),
      };
    }),
  );

  const types: JobTypeOption[] = SCHEDULED_JOB_TYPES_LIST.map((type) => ({
    type,
    label: definitions[type].label,
    description: definitions[type].description,
    defaultCron: definitions[type].defaultCron,
    defaultKey: definitions[type].defaultKey,
  }));

  return (
    <>
      <LiveRefresh topics={['jobs']} />
      <JobsPanel
        jobs={jobs}
        types={types}
        canManage={auth.can('job:manage')}
        defaultTimeZone={defaultTimeZone}
        timeZones={timeZones}
        format={formatSettingsOf(settings)}
      />
    </>
  );
}
