'use client';

import { cronError, type SimpleSchedule } from '@pupitre/core/schedule';
import { useRouter } from 'next/navigation';
import { Fragment, useState, useTransition } from 'react';
import { Ellipsis, History, Play, Plus, Power, Timer, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import { IconButton } from '@/components/ui/tooltip';
import { useLanguage, useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { jobs as messages } from '@/i18n/messages/jobs';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import { toast } from '@/lib/toast';
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

const STATUS_VARIANT: Record<string, 'ok' | 'accent' | 'danger' | 'idle'> = {
  success: 'ok',
  running: 'accent',
  failed: 'danger',
  skipped: 'idle',
  pending: 'idle',
};

const STATUS_KEY: Record<string, keyof typeof messages.fr> = {
  success: 'status.success',
  running: 'status.running',
  failed: 'status.failed',
  skipped: 'status.skipped',
  pending: 'status.pending',
};

/** Le statut d'une exécution, en pastille : un mot traduit, jamais la valeur brute. */
function RunStatus({ run }: { run: JobRunView }) {
  const t = useT(messages);
  const key = STATUS_KEY[run.status];
  return (
    <Badge variant={STATUS_VARIANT[run.status] ?? 'idle'} dot>
      {key ? t(key) : run.status}
      {run.manual ? t('row.manualSuffix') : ''}
    </Badge>
  );
}

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
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<JobRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<JobRow | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  /**
   * Un appel d'API. Le refus s'affiche là où l'on regarde : dans le dialogue
   * ouvert s'il y en a un (`inDialog`), sinon en tête de page.
   */
  async function call(
    path: string,
    init: RequestInit,
    onDone: () => string | null,
    inDialog = false,
  ): Promise<boolean> {
    setError(null);
    setDialogError(null);
    setBusy(path);
    try {
      const response = await fetch(path, init);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ApiError;
        const message = body.error?.message ?? tc('http.failure', { status: response.status });
        if (inDialog) setDialogError(message);
        else setError(message);
        return false;
      }
      const message = onDone();
      if (message) toast({ title: message });
      startTransition(() => router.refresh());
      return true;
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={
          <>
            <JobsHelpDialog defaultTimeZone={defaultTimeZone} />
            {canManage ? (
              <Button
                onClick={() => {
                  setDialogError(null);
                  setCreating(true);
                }}
              >
                <Plus aria-hidden />
                {t('page.schedule')}
              </Button>
            ) : null}
          </>
        }
      />

      <Alert variant="info">
        {t('banner.a')}
        <strong>{defaultTimeZone}</strong>
        {t('banner.b')}
      </Alert>

      {error ? <Alert variant="destructive">{error}</Alert> : null}

      {jobs.length === 0 ? (
        <Alert>{t('empty')}</Alert>
      ) : (
        <section className="card overflow-hidden">
          <Table label={t('page.title')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('column.job')}</TableHead>
                <TableHead>{t('column.cadence')}</TableHead>
                <TableHead>{t('column.lastRun')}</TableHead>
                <TableHead>{t('column.nextRun')}</TableHead>
                <TableHead>{tc('column.state')}</TableHead>
                <TableActionsHead>
                  <span className="sr-only">{tc('column.actions')}</span>
                </TableActionsHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job) => (
                <Fragment key={job.id}>
                  <TableRow>
                    <TableCell>
                      <span className="flex flex-col" title={job.neverDoes}>
                        <span className="mono text-[12.5px] font-semibold text-text">
                          {job.key}
                        </span>
                        <span className="t-cap text-text-3">{job.label}</span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col">
                        <span className="t-sm">{job.cronDescription}</span>
                        <code className="mono text-[11.5px] text-text-3">{job.cron}</code>
                        {job.schedule === null ? (
                          <span className="t-cap text-text-3">{t('row.noSimpleForm')}</span>
                        ) : null}
                        {job.enabled &&
                        job.installed &&
                        job.schedulerTimeZone !== null &&
                        job.schedulerTimeZone !== job.timeZone ? (
                          <span className="t-cap text-warn-text">
                            {t('row.zoneDrift', { zone: job.schedulerTimeZone })}
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      {job.lastRun ? (
                        <span className="flex flex-col items-start gap-0.5">
                          <RunStatus run={job.lastRun} />
                          <span className="mono text-[11.5px] text-text-3">
                            {formatDate(job.lastRunAt, format, tc('none'))}
                          </span>
                        </span>
                      ) : (
                        <span className="t-cap text-text-3">{t('row.lastRun.none')}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {job.enabled ? (
                        <span className="flex flex-col">
                          <span className="mono text-[12px] text-text-2">
                            {formatDate(job.nextRunAt, format, tc('none'), job.timeZone)}
                          </span>
                          {job.nextRunAt ? (
                            <span className="t-cap text-text-3">
                              {t('row.yourClock', {
                                clock: formatDate(job.nextRunAt, format, tc('none')),
                              })}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-text-3">{tc('none')}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col items-start gap-1">
                        <Badge variant={job.enabled ? 'ok' : 'idle'}>
                          {job.enabled ? t('row.active') : t('row.disabled')}
                        </Badge>
                        {job.enabled && !job.installed ? (
                          <span className="t-cap text-warn-text">{t('row.missingFromBullmq')}</span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableActions>
                      <span className="inline-flex items-center gap-1.5">
                        {canManage ? (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy !== null}
                              onClick={() => {
                                setDialogError(null);
                                setEditing(job);
                              }}
                            >
                              {t('row.editCadence')}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy !== null}
                              onClick={() =>
                                void call(`/api/jobs/${job.id}/run`, { method: 'POST' }, () =>
                                  t('notice.triggered', { key: job.key }),
                                )
                              }
                            >
                              <Play aria-hidden />
                              {t('row.runNow')}
                            </Button>
                          </>
                        ) : null}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <IconButton label={t('row.more')} size="icon-sm">
                              <Ellipsis />
                            </IconButton>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onSelect={() => setExpanded(expanded === job.id ? null : job.id)}
                            >
                              <History aria-hidden />
                              {expanded === job.id ? t('row.hideHistory') : t('row.showHistory')}
                            </DropdownMenuItem>
                            {canManage ? (
                              <>
                                <DropdownMenuItem
                                  onSelect={() =>
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
                                  <Power aria-hidden />
                                  {job.enabled ? tc('disable') : tc('enable')}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  destructive
                                  onSelect={() => {
                                    setDialogError(null);
                                    setDeleting(job);
                                  }}
                                >
                                  <Trash2 aria-hidden />
                                  {t('delete.confirm')}…
                                </DropdownMenuItem>
                              </>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </span>
                    </TableActions>
                  </TableRow>

                  {expanded === job.id ? (
                    <TableRow>
                      <TableCell colSpan={6} className="bg-surface-2">
                        {job.runs.length === 0 ? (
                          <p className="t-sm text-text-2">{t('history.empty')}</p>
                        ) : (
                          <ul className="flex flex-col gap-2">
                            {job.runs.map((run) => (
                              <li key={run.id} className="t-sm flex flex-wrap items-center gap-3">
                                <RunStatus run={run} />
                                <span className="mono text-text-2">
                                  {formatDate(run.startedAt, format, tc('none'))}
                                </span>
                                <span className="num text-text-3">
                                  {formatDuration(run.durationMs, tc('none'))}
                                </span>
                                {run.manual ? (
                                  <span className="t-cap text-text-3">{t('history.manual')}</span>
                                ) : null}
                                <span
                                  className={cn(
                                    'mono max-w-2xl truncate text-[11.5px] text-text-3',
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
        </section>
      )}

      {creating ? (
        <CreateDialog
          types={types}
          defaultTimeZone={defaultTimeZone}
          timeZones={timeZones}
          format={format}
          busy={busy !== null || pending}
          error={dialogError}
          onClose={() => setCreating(false)}
          onSubmit={async (body, key) => {
            const done = await call(
              '/api/jobs',
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                // `draftBody` envoie la périodicité ou l'expression : la
                // conversion et la validation sont l'affaire du serveur.
                body: JSON.stringify(body),
              },
              () => t('notice.created', { key }),
              true,
            );
            if (done) setCreating(false);
          }}
        />
      ) : null}

      {editing ? (
        <CadenceDialog
          // Remonté à chaque ouverture : le brouillon repart de la cadence
          // enregistrée, sans avoir à le resynchroniser dans un effet.
          key={editing.id}
          job={editing}
          timeZones={timeZones}
          format={format}
          busy={busy !== null || pending}
          error={dialogError}
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
              true,
            );
            if (done) setEditing(null);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        level="trace"
        icon={<Trash2 />}
        title={deleting ? t('delete.title', { key: deleting.key }) : ''}
        consequences={[t('delete.schedule'), t('delete.history')]}
        confirmLabel={t('delete.confirm')}
        pending={busy !== null}
        error={dialogError}
        onConfirm={async () => {
          if (!deleting) return;
          const done = await call(
            `/api/jobs/${deleting.id}`,
            { method: 'DELETE' },
            () => t('notice.deleted', { key: deleting.key }),
            true,
          );
          if (done) setDeleting(null);
        }}
      />
    </>
  );
}

/** Planification d'une tâche neuve : son type, sa clé, sa cadence. */
function CreateDialog({
  types,
  defaultTimeZone,
  timeZones,
  format,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  types: JobTypeOption[];
  defaultTimeZone: string;
  timeZones: readonly string[];
  format: FormatSettings;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>, key: string) => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const language = useLanguage();
  const [type, setType] = useState(types[0]?.type ?? 'scan');
  const [key, setKey] = useState(types[0]?.defaultKey ?? 'scan:periodic');
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    draftFromCron(types[0]?.defaultCron ?? '0 4 * * *', defaultTimeZone),
  );
  const invalid = cronError(draftCron(draft), language) !== null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent size="wide">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({ type, key, ...draftBody(draft) }, key);
          }}
        >
          <DialogHeader icon={<Timer />} tone="accent">
            <DialogTitle>{t('page.schedule')}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {error ? <Alert variant="destructive">{error}</Alert> : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t('create.type.label')}
                help={types.find((entry) => entry.type === type)?.description}
              >
                <Select
                  value={type}
                  onChange={(event) => {
                    const next = types.find((entry) => entry.type === event.target.value);
                    setType(event.target.value);
                    if (next) {
                      setKey(next.defaultKey);
                      // Le fuseau déjà choisi survit au changement de type :
                      // c'est un réglage de l'opérateur, pas une propriété du type.
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
              </Field>
              <Field label={t('create.key.label')} help={t('create.key.hint')}>
                <Input
                  className="mono"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                />
              </Field>
            </div>
            <ScheduleField
              idPrefix="new"
              value={draft}
              onChange={setDraft}
              timeZones={timeZones}
              format={format}
              disabled={busy}
            />
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" type="button">
                {tc('cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" loading={busy} disabled={invalid}>
              {t('create.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Modification de la cadence d'une tâche existante. */
function CadenceDialog({
  job,
  timeZones,
  format,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  job: JobRow;
  timeZones: readonly string[];
  format: FormatSettings;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (
    body: ({ schedule: SimpleSchedule } | { cron: string }) & { timezone: string },
  ) => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const language = useLanguage();
  const [draft, setDraft] = useState<ScheduleDraft>(() => draftFromCron(job.cron, job.timeZone));
  const invalid = cronError(draftCron(draft), language) !== null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader icon={<Timer />} tone="accent">
          <DialogTitle>{t('dialog.title', { key: job.key })}</DialogTitle>
          <DialogDescription>
            {job.label} — {job.neverDoes}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          {job.schedule === null ? <p className="help">{t('dialog.expertOnly')}</p> : null}

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
            <Button variant="ghost" type="button">
              {tc('cancel')}
            </Button>
          </DialogClose>
          <Button
            type="button"
            loading={busy}
            disabled={invalid}
            onClick={() => onSubmit(draftBody(draft))}
          >
            {t('dialog.save')}
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
    .filter(
      ([field, value]) =>
        field !== 'log' && (typeof value === 'number' || typeof value === 'string'),
    )
    .map(([field, value]) => `${field}=${String(value)}`);
  return entries.join(' · ');
}
