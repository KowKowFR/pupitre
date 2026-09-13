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
import { PageHeader } from '@/components/page-header';
import { currentLanguage, getT } from '@/i18n/server';
import { jobs as messages } from '@/i18n/messages/jobs';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { schedulerStates } from '@/lib/schedules';
import { JobsPanel, type JobRow, type JobTypeOption } from './jobs-panel';

export const dynamic = 'force-dynamic';

/**
 * Tâches planifiées.
 *
 * La page lit la base — la source de vérité — et la complète par l'état des
 * schedulers dans Redis, d'où vient la prochaine occurrence. Un écart entre les
 * deux est affiché plutôt que masqué : c'est une information d'exploitation.
 */
export default async function JobsPage() {
  const auth = await requirePagePermission('/jobs', 'job:read');
  const t = await getT(messages);
  const language = await currentLanguage();
  const definitions = scheduledJobTypes(language);

  const [rows, states, lastRuns, settings] = await Promise.all([
    listScheduledJobs(),
    schedulerStates(),
    lastRunsByJob(),
    getAppSettingsValue(),
  ]);

  // Deux fuseaux distincts, à ne pas confondre : celui d'une tâche, qui vit dans
  // sa ligne, et celui des paramètres d'instance, qui ne sert qu'à pré-remplir
  // le formulaire d'une tâche neuve.
  const defaultTimeZone = settings.timezone;

  // Liste énumérée côté serveur : c'est l'ICU du process qui valide la saisie,
  // et proposer au navigateur un fuseau que le serveur refuserait — ou l'inverse
  // — produirait un choix impossible à enregistrer.
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
        // `null` sur un scheduler installé avant la migration `0009`, ou absent
        // de Redis. Différent du fuseau de la ligne = l'heure affichée n'est pas
        // encore celle à laquelle BullMQ va tirer.
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
          durationMs: run.finishedAt
            ? run.finishedAt.getTime() - run.startedAt.getTime()
            : null,
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
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t('page.eyebrow')}
        title={t('page.title')}
        description={t('page.description')}
      />

      <JobsPanel
        jobs={jobs}
        types={types}
        canManage={auth.can('job:manage')}
        defaultTimeZone={defaultTimeZone}
        timeZones={timeZones}
        format={formatSettingsOf(settings)}
      />
    </div>
  );
}
