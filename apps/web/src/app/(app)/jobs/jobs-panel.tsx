'use client';

import { cronError, type SimpleSchedule } from '@tp/core/schedule';
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

function formatDate(value: string | null, timeZone?: string): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  });
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
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
}: {
  jobs: JobRow[];
  types: JobTypeOption[];
  canManage: boolean;
  /** Fuseau des paramètres d'instance : le pré-réglage d'une tâche neuve. */
  defaultTimeZone: string;
  /** Fuseaux proposés, énumérés côté serveur. */
  timeZones: readonly string[];
}) {
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
        setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
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

  const draftInvalid = cronError(draftCron(draft)) !== null;

  return (
    <div className="flex flex-col gap-5">
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {notice ? <Alert variant="success">{notice}</Alert> : null}

      <Alert variant="info" className="flex flex-wrap items-center justify-between gap-3">
        <span>
          Ces tâches se répètent d&apos;elles-mêmes pour surveiller ce qui est déjà déployé —
          scanner à nouveau les images, sonder la santé, purger les anciennes versions. Elles
          constatent et alertent&nbsp;; aucune ne redéploie, ne rollback ni ne bloque. Chaque
          tâche porte son propre fuseau&nbsp;; une nouvelle part de{' '}
          <strong>{defaultTimeZone}</strong>, celui des paramètres d&apos;instance.
        </span>
        <JobsHelpDialog defaultTimeZone={defaultTimeZone} className="shrink-0" />
      </Alert>

      {canManage ? (
        <form
          className="flex flex-col gap-4 rounded-lg border border-line bg-card p-4 shadow-panel"
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
              () => `Tâche « ${key} » planifiée`,
            );
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="type">Type</Label>
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
              <p className="text-xs text-ink-muted">
                {types.find((entry) => entry.type === type)?.description}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="key">Clé BullMQ</Label>
              <Input
                id="key"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                className="font-mono text-xs md:text-xs"
              />
              <p className="text-xs text-ink-muted">
                L&apos;identifiant du scheduler dans Redis. Unique, et c&apos;est ce nom
                qu&apos;on retrouve dans les logs du worker.
              </p>
            </div>
          </div>

          <ScheduleField
            idPrefix="new"
            value={draft}
            onChange={setDraft}
            timeZones={timeZones}
            disabled={pending || busy !== null}
          />

          <div>
            <Button type="submit" disabled={pending || busy !== null || draftInvalid}>
              Planifier
            </Button>
          </div>
        </form>
      ) : null}

      {jobs.length === 0 ? (
        <Alert>
          Aucune tâche planifiée. Les scans périodiques, les healthchecks et la purge des
          versions ne tournent que si vous les installez ici.
        </Alert>
      ) : (
        <Card className="py-4">
          <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tâche</TableHead>
              <TableHead>Cadence</TableHead>
              <TableHead>Dernier run</TableHead>
              <TableHead>Prochain run</TableHead>
              <TableHead>État</TableHead>
              <TableActionsHead>Actions</TableActionsHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => (
              <Fragment key={job.id}>
                <TableRow>
                  <TableCell>
                    <div className="text-[0.8125rem] font-medium text-ink">{job.label}</div>
                    <div className="font-mono text-[0.6875rem] text-ink-faint">{job.key}</div>
                    <div className="mt-1 max-w-md text-xs text-ink-muted">{job.neverDoes}</div>
                  </TableCell>
                  <TableCell>
                    <div className="text-[0.8125rem] text-ink">{job.cronDescription}</div>
                    <code className="font-mono text-[0.6875rem] text-ink-faint">{job.cron}</code>
                    <div className="text-[0.6875rem] text-ink-faint">{job.timeZone}</div>
                    {job.schedule === null ? (
                      <div className="text-[0.6875rem] text-ink-faint">
                        expression sans équivalent simple
                      </div>
                    ) : null}
                    {job.enabled &&
                    job.installed &&
                    job.schedulerTimeZone !== null &&
                    job.schedulerTimeZone !== job.timeZone ? (
                      <div className="text-[0.6875rem] text-warn">
                        BullMQ l&apos;interprète encore en {job.schedulerTimeZone}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div className="font-mono text-xs text-ink-muted tabular-nums">
                      {formatDate(job.lastRunAt)}
                    </div>
                    {job.lastRun ? (
                      <Badge variant={STATUS_VARIANT[job.lastRun.status] ?? 'outline'}>
                        {job.lastRun.status}
                        {job.lastRun.manual ? ' · manuel' : ''}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-ink-muted tabular-nums">
                    {job.enabled ? formatDate(job.nextRunAt, job.timeZone) : '—'}
                    {job.enabled && job.nextRunAt ? (
                      <div className="text-[0.6875rem] text-ink-faint">
                        {job.timeZone}
                        {' · '}
                        {formatDate(job.nextRunAt)} chez vous
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={job.enabled ? 'ok' : 'outline'}>
                      {job.enabled ? 'active' : 'désactivée'}
                    </Badge>
                    {job.enabled && !job.installed ? (
                      <div className="mt-1 text-xs text-warn">
                        absente de BullMQ — le worker la réinstallera au démarrage
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
                      {expanded === job.id ? 'Masquer' : 'Historique'}
                    </Button>
                    {canManage ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => setEditing(job)}
                        >
                          Cadence
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() =>
                            void call(
                              `/api/jobs/${job.id}/run`,
                              { method: 'POST' },
                              () => `« ${job.key} » lancée`,
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
                                  ? `« ${job.key} » désactivée`
                                  : `« ${job.key} » activée`,
                            )
                          }
                        >
                          {job.enabled ? 'Désactiver' : 'Activer'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger hover:bg-danger-soft/60 hover:text-danger"
                          disabled={busy !== null}
                          onClick={() =>
                            void call(
                              `/api/jobs/${job.id}`,
                              { method: 'DELETE' },
                              () => `« ${job.key} » supprimée`,
                            )
                          }
                        >
                          Supprimer
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
                        <p className="text-xs text-ink-muted">
                          Aucune exécution enregistrée.
                        </p>
                      ) : (
                        <ul className="space-y-2">
                          {job.runs.map((run) => (
                            <li key={run.id} className="flex flex-wrap items-start gap-3 text-xs">
                              <Badge variant={STATUS_VARIANT[run.status] ?? 'outline'}>
                                {run.status}
                              </Badge>
                              <span className="font-mono text-ink-muted tabular-nums">
                                {formatDate(run.startedAt)}
                              </span>
                              <span className="text-ink-faint">{formatDuration(run.durationMs)}</span>
                              {run.manual ? <span>déclenchée à la main</span> : null}
                              <span
                                className={cn(
                                  'max-w-2xl truncate font-mono text-ink-faint',
                                  run.error && 'text-danger',
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
              () => `Cadence de « ${editing.key} » modifiée`,
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
  busy,
  onClose,
  onSubmit,
}: {
  job: JobRow;
  timeZones: readonly string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (
    body: ({ schedule: SimpleSchedule } | { cron: string }) & { timezone: string },
  ) => void;
}) {
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    draftFromCron(job.cron, job.timeZone),
  );
  const invalid = cronError(draftCron(draft)) !== null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cadence de « {job.key} »</DialogTitle>
          <DialogDescription>
            {job.label} — {job.neverDoes}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          {job.schedule === null ? (
            <p className="text-xs text-ink-faint">
              L&apos;expression enregistrée n&apos;a pas d&apos;équivalent en mode simple :
              l&apos;écran s&apos;ouvre en mode expert plutôt que d&apos;afficher une
              périodicité approchée.
            </p>
          ) : null}

          <ScheduleField
            idPrefix={`edit-${job.id}`}
            value={draft}
            onChange={setDraft}
            timeZones={timeZones}
            disabled={busy}
          />
        </DialogBody>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" type="button">
              Annuler
            </Button>
          </DialogClose>
          <Button type="button" disabled={busy || invalid} onClick={() => onSubmit(draftBody(draft))}>
            Enregistrer
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
