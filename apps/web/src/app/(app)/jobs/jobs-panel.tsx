'use client';

import { cronError, type SimpleSchedule } from '@pupitre/core/schedule';
import { useRouter } from 'next/navigation';
import { Fragment, useState, useTransition } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableActions,
  TableActionsHead,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useLanguage, useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { jobs as messages } from '@/i18n/messages/jobs';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import { cn } from '@/lib/utils';
import { JobsHelpDialog } from './jobs-help';
import {
  ScheduleField,
  draftBody,
  draftCron,
  draftFromCron,
  type ScheduleDraft,
} from './schedule-field';

export type JobRunView = {
  id: string;
  status: string;
  manual: boolean;
  summary: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
};

export type JobRow = {
  id: string;
  key: string;
  type: string;
  jobName: string;
  label: string;
  description: string;
  neverDoes: string;
  cron: string;
  cronDescription: string;
  /** `null` quand l'expression n'a pas d'équivalent en mode simple. */
  schedule: SimpleSchedule | null;
  /** Fuseau de la tâche : celui dans lequel BullMQ interprète son cron. */
  timeZone: string;
  /** Fuseau réellement mémorisé par BullMQ. `null` = pas encore installé. */
  schedulerTimeZone: string | null;
  enabled: boolean;
  installed: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRun: JobRunView | null;
  runs: JobRunView[];
};

export type JobTypeOption = {
  type: string;
  label: string;
  description: string;
  defaultCron: string;
  defaultKey: string;
};

const STATUS_VARIANT: Record<string, 'ok' | 'default' | 'destructive' | 'outline'> = {
  success: 'ok',
  running: 'default',
  failed: 'destructive',
  skipped: 'outline',
  pending: 'outline',
};

/**
 * Une date de la table, dans la locale de l'instance.
 *
 * `dateStyle`/`timeStyle` courts sont imposés par la colonne : une date longue
 * casserait l'alignement des chiffres. La locale, elle, vient de
 * `settings.locale` telle quelle — `en-GB` et `en-US` n'écrivent pas la même
 * date, et le raccourci d'avant servait la britannique aux deux.
 *
 * Le `timeZone` reste facultatif, et c'est délibéré : la colonne « prochaine
 * occurrence » l'épingle sur le fuseau **de la tâche**, tandis que la ligne
 * « à votre horloge » veut justement l'absence de fuseau. Ni l'un ni l'autre
 * n'est le fuseau d'instance.
 */
function formatDate(
  value: string | null,
  format: FormatSettings,
  none: string,
  timeZone?: string,
): string {
  return formatDateTimeWith(
    value,
    format,
    { dateStyle: 'short', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) },
    none,
  );
}

function formatDuration(ms: number | null, none: string): string {
  if (ms === null) return none;
  if (ms < 1000) return `${ms} ms`;
  return `${Math.round(ms / 100) / 10} s`;
}

type ApiError = { error?: { message?: string } };

export function JobsPanel({
  jobs,
  types,
  canManage,
  defaultTimeZone,
  timeZones,
  format,
}: {
  jobs: JobRow[];
  types: JobTypeOption[];
  canManage: boolean;
  /** Fuseau des paramètres d'instance : le pré-réglage d'une tâche neuve. */
  defaultTimeZone: string;
  /** Fuseaux proposés, énumérés côté serveur. */
  timeZones: readonly string[];
  /** Locale et fuseau de l'instance. Par props : cette table est rendue sur le
   *  serveur avant de l'être ici, et les deux doivent écrire la même date. */
  format: FormatSettings;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const language = useLanguage();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<JobRow | null>(null);

  const [type, setType] = useState(types[0]?.type ?? 'scan');
  const [key, setKey] = useState(types[0]?.defaultKey ?? 'scan:periodic');
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    draftFromCron(types[0]?.defaultCron ?? '0 4 * * *', defaultTimeZone),
  );

  async function call(
    path: string,
    init: RequestInit,
    onDone: (body: unknown) => string | null,
  ): Promise<boolean> {
    setError(null);
    setNotice(null);
    setBusy(path);
    try {
      const response = await fetch(path, init);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ApiError;
        setError(body.error?.message ?? tc('http.failure', { status: response.status }));
        return false;
      }
      const body = response.status === 204 ? null : await response.json().catch(() => null);
      const message = onDone(body);
      if (message) setNotice(message);
      startTransition(() => router.refresh());
      return true;
    } finally {
      setBusy(null);
    }
  }

  const draftInvalid = cronError(draftCron(draft), language) !== null;

  return (
    <div className="flex flex-col gap-5">
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {notice ? <Alert variant="success">{notice}</Alert> : null}

      <Alert variant="info" className="flex flex-wrap items-center justify-between gap-3">
        <span>
          {t('banner.a')}
          <strong>{defaultTimeZone}</strong>
          {t('banner.b')}
        </span>
        <JobsHelpDialog defaultTimeZone={defaultTimeZone} className="shrink-0" />
      </Alert>

      {canManage ? (
        <form
          className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 shadow-xs"
          onSubmit={(event) => {
            event.preventDefault();
            void call(
              '/api/jobs',
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                // `draftBody` envoie la périodicité ou l'expression : la
                // conversion et la validation sont l'affaire du serveur.
                body: JSON.stringify({ type, key, ...draftBody(draft) }),
              },
              () => t('notice.created', { key }),
            );
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="type">{t('create.type.label')}</Label>
              <Select
                id="type"
                value={type}
                onChange={(event) => {
                  const next = types.find((entry) => entry.type === event.target.value);
                  setType(event.target.value);
                  if (next) {
                    setKey(next.defaultKey);
                    // Le fuseau déjà choisi survit au changement de type : c'est
                    // un réglage de l'opérateur, pas une propriété du type.
                    setDraft(draftFromCron(next.defaultCron, draft.timeZone));
                  }
                }}
              >
                {types.map((entry) => (
                  <option key={entry.type} value={entry.type}>
                    {entry.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-text-2">
                {types.find((entry) => entry.type === type)?.description}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="key">{t('create.key.label')}</Label>
              <Input
                id="key"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                className="font-mono text-xs md:text-xs"
              />
              <p className="text-xs text-text-2">{t('create.key.hint')}</p>
            </div>
          </div>

          <ScheduleField
            idPrefix="new"
            value={draft}
            onChange={setDraft}
            timeZones={timeZones}
            format={format}
            disabled={pending || busy !== null}
          />

          <div>
            <Button type="submit" disabled={pending || busy !== null || draftInvalid}>
              {t('create.submit')}
            </Button>
          </div>
        </form>
      ) : null}

      {jobs.length === 0 ? (
        <Alert>{t('empty')}</Alert>
      ) : (
        <Card className="py-4">
          <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('column.job')}</TableHead>
              <TableHead>{t('column.cadence')}</TableHead>
              <TableHead>{t('column.lastRun')}</TableHead>
              <TableHead>{t('column.nextRun')}</TableHead>
              <TableHead>{tc('column.state')}</TableHead>
              <TableActionsHead>{tc('column.actions')}</TableActionsHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => (
              <Fragment key={job.id}>
                <TableRow>
                  <TableCell>
                    <div className="text-[0.8125rem] font-medium text-text">{job.label}</div>
                    <div className="font-mono text-[0.6875rem] text-text-3">{job.key}</div>
                    <div className="mt-1 max-w-md text-xs text-text-2">{job.neverDoes}</div>
                  </TableCell>
                  <TableCell>
                    <div className="text-[0.8125rem] text-text">{job.cronDescription}</div>
                    <code className="font-mono text-[0.6875rem] text-text-3">{job.cron}</code>
                    <div className="text-[0.6875rem] text-text-3">{job.timeZone}</div>
                    {job.schedule === null ? (
                      <div className="text-[0.6875rem] text-text-3">
                        {t('row.noSimpleForm')}
                      </div>
                    ) : null}
                    {job.enabled &&
                    job.installed &&
                    job.schedulerTimeZone !== null &&
                    job.schedulerTimeZone !== job.timeZone ? (
                      <div className="text-[0.6875rem] text-warn-text">
                        {t('row.zoneDrift', { zone: job.schedulerTimeZone })}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div className="font-mono text-xs text-text-2 tabular-nums">
                      {formatDate(job.lastRunAt, format, tc('none'))}
                    </div>
                    {job.lastRun ? (
                      <Badge variant={STATUS_VARIANT[job.lastRun.status] ?? 'outline'}>
                        {job.lastRun.status}
                        {job.lastRun.manual ? t('row.manualSuffix') : ''}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-text-2 tabular-nums">
                    {job.enabled
                      ? formatDate(job.nextRunAt, format, tc('none'), job.timeZone)
                      : tc('none')}
                    {job.enabled && job.nextRunAt ? (
                      <div className="text-[0.6875rem] text-text-3">
                        {job.timeZone}
                        {' · '}
                        {t('row.yourClock', {
                          clock: formatDate(job.nextRunAt, format, tc('none')),
                        })}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={job.enabled ? 'ok' : 'outline'}>
                      {job.enabled ? t('row.active') : t('row.disabled')}
                    </Badge>
                    {job.enabled && !job.installed ? (
                      <div className="mt-1 text-xs text-warn-text">
                        {t('row.missingFromBullmq')}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableActions>
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setExpanded(expanded === job.id ? null : job.id)}
                    >
                      {expanded === job.id ? t('row.hideHistory') : t('row.showHistory')}
                    </Button>
                    {canManage ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => setEditing(job)}
                        >
                          {t('row.editCadence')}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() =>
                            void call(
                              `/api/jobs/${job.id}/run`,
                              { method: 'POST' },
                              () => t('notice.triggered', { key: job.key }),
                            )
                          }
                        >
                          Lancer
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy !== null}
                          onClick={() =>
                            void call(
                              `/api/jobs/${job.id}`,
                              {
                                method: 'PATCH',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ enabled: !job.enabled }),
                              },
                              () =>
                                job.enabled
                                  ? t('notice.disabled', { key: job.key })
                                  : t('notice.enabled', { key: job.key }),
                            )
                          }
                        >
                          {job.enabled ? tc('disable') : tc('enable')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger-text hover:bg-danger-soft/60 hover:text-danger-text"
                          disabled={busy !== null}
                          onClick={() =>
                            void call(
                              `/api/jobs/${job.id}`,
                              { method: 'DELETE' },
                              () => t('notice.deleted', { key: job.key }),
                            )
                          }
                        >
                          {tc('delete')}
                        </Button>
                      </>
                    ) : null}
                    </div>
                  </TableActions>
                </TableRow>

                {expanded === job.id ? (
                  <TableRow>
                    <TableCell colSpan={6} className="bg-surface-2/60">
                      {job.runs.length === 0 ? (
                        <p className="text-xs text-text-2">
                          {t('history.empty')}
                        </p>
                      ) : (
                        <ul className="space-y-2">
                          {job.runs.map((run) => (
                            <li key={run.id} className="flex flex-wrap items-start gap-3 text-xs">
                              <Badge variant={STATUS_VARIANT[run.status] ?? 'outline'}>
                                {run.status}
                              </Badge>
                              <span className="font-mono text-text-2 tabular-nums">
                                {formatDate(run.startedAt, format, tc('none'))}
                              </span>
                              <span className="text-text-3">
                                {formatDuration(run.durationMs, tc('none'))}
                              </span>
                              {run.manual ? <span>{t('history.manual')}</span> : null}
                              <span
                                className={cn(
                                  'max-w-2xl truncate font-mono text-text-3',
                                  run.error && 'text-danger-text',
                                )}
                              >
                                {run.error ?? summarize(run.summary)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            ))}
          </TableBody>
        </Table>
          </CardContent>
        </Card>
      )}

      {editing ? (
        <CadenceDialog
          // Remonté à chaque ouverture : le brouillon repart de la cadence
          // enregistrée, sans avoir à le resynchroniser dans un effet.
          key={editing.id}
          job={editing}
          timeZones={timeZones}
          format={format}
          busy={busy !== null || pending}
          onClose={() => setEditing(null)}
          onSubmit={async (body) => {
            const done = await call(
              `/api/jobs/${editing.id}`,
              {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              },
              () => t('notice.cadenceUpdated', { key: editing.key }),
            );
            if (done) setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** Modification de la cadence d'une tâche existante. */
function CadenceDialog({
  job,
  timeZones,
  format,
  busy,
  onClose,
  onSubmit,
}: {
  job: JobRow;
  timeZones: readonly string[];
  format: FormatSettings;
  busy: boolean;
  onClose: () => void;
  onSubmit: (
    body: ({ schedule: SimpleSchedule } | { cron: string }) & { timezone: string },
  ) => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const language = useLanguage();
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    draftFromCron(job.cron, job.timeZone),
  );
  const invalid = cronError(draftCron(draft), language) !== null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('dialog.title', { key: job.key })}</DialogTitle>
          <DialogDescription>
            {job.label} — {job.neverDoes}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          {job.schedule === null ? (
            <p className="text-xs text-text-3">{t('dialog.expertOnly')}</p>
          ) : null}

          <ScheduleField
            idPrefix={`edit-${job.id}`}
            value={draft}
            onChange={setDraft}
            timeZones={timeZones}
            format={format}
            disabled={busy}
          />
        </DialogBody>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" type="button">
              {tc('cancel')}
            </Button>
          </DialogClose>
          <Button type="button" disabled={busy || invalid} onClick={() => onSubmit(draftBody(draft))}>
            {tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Résumé d'exécution en une ligne : les compteurs, pas le journal complet. */
function summarize(summary: unknown): string {
  if (summary === null || typeof summary !== 'object') return '';
  const entries = Object.entries(summary as Record<string, unknown>)
    .filter(([field, value]) => field !== 'log' && (typeof value === 'number' || typeof value === 'string'))
    .map(([field, value]) => `${field}=${String(value)}`);
  return entries.join(' · ');
}
