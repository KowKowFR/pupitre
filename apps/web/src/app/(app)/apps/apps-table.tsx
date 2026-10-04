'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { RotateCw, ScrollText } from 'lucide-react';
import { translator, type DeploymentStatus, type Translate } from '@pupitre/core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { State, type Tone } from '@/components/ui/led';
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
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { servers } from '@/i18n/messages/servers';
import { toast } from '@/lib/toast';

export type HealthStatus = 'unknown' | 'healthy' | 'unhealthy' | 'unreachable';

/**
 * The last update attempt, when it failed.
 *
 * Its presence is what tells "this application runs" from "this application
 * runs, but not in the version one wanted to put there". Making it disappear
 * from the screen was the bug: a live application became invisible as soon as a
 * deployment failed behind it.
 */
export type LastFailedUpdateRow = {
  deploymentId: string;
  version: number;
  failedStep: string | null;
  mayHaveReplacedServices: boolean;
};

export type SupervisedRow = {
  id: string;
  applicationSlug: string;
  targetId: string;
  targetName: string;
  targetHost: string;
  runtime: 'docker' | 'k3s';
  version: number;
  status: DeploymentStatus;
  healthStatus: HealthStatus;
  lastHealthAt: string | null;
  url: string | null;
  publishedPort: number | null;
  services: string[];
  startedAt: string | null;
  lastFailedUpdate: LastFailedUpdateRow | null;
};

type ApiError = { error?: { message?: string } };

type T = Translate<typeof servers.fr>;

const HEALTH_KEY: Record<HealthStatus, keyof typeof servers.fr> = {
  healthy: 'health.healthy',
  unhealthy: 'health.unhealthy',
  unreachable: 'health.unreachable',
  unknown: 'health.unknown',
};

const HEALTH_TONE: Record<HealthStatus, Tone> = {
  healthy: 'ok',
  unhealthy: 'warn',
  unreachable: 'danger',
  unknown: 'idle',
};

/**
 * Link indicator: the shape carries the information as much as the color.
 *
 * `label` allows reusing the same indicator for a **machine**'s state, whose
 * vocabulary is not an application's — "operational" rather than "running". A
 * single indicator in the whole monitoring screen, hence a single reading
 * convention to learn.
 */
export function HealthDot({
  health,
  label,
  meta,
}: {
  health: HealthStatus;
  label?: string;
  meta?: ReactNode;
}) {
  const t = useT(servers);
  return (
    <State tone={HEALTH_TONE[health]} meta={meta}>
      {label ?? t(HEALTH_KEY[health])}
    </State>
  );
}

/**
 * French, frozen, for the callers that do not have a `t` at hand yet — the site
 * monitoring screens import this function and are translated separately. They get
 * exactly the former string as long as they pass nothing; the day they pass their
 * `t`, the function follows.
 */
const sinceInFrench = translator(servers, 'fr');

export function formatSince(iso: string | null, t: T = sinceInFrench): string {
  if (!iso) return t('since.none');
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return t('since.seconds', { count: seconds });
  if (seconds < 3600) return t('since.minutes', { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('since.hours', { count: Math.floor(seconds / 3600) });
  return t('since.days', { count: Math.floor(seconds / 86400) });
}

/**
 * The monitored applications of **one** server.
 *
 * The "Target" column is gone: it repeated on each row what the card containing
 * the table already announces once. The table no longer wraps itself in a card
 * either — it is the server's card that carries the surface, otherwise two frames
 * are stacked for a single piece of information.
 */
export function AppsTable({
  items,
  canRestart,
  onOpen,
}: {
  items: SupervisedRow[];
  canRestart: boolean;
  /** Opens the application in its drawer. */
  onOpen: (id: string) => void;
}) {
  const t = useT(servers);
  const shared = useT(common);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState<SupervisedRow | null>(null);

  async function restart(app: SupervisedRow) {
    setBusy(true);
    setError(null);

    const response = await fetch(`/api/apps/${app.id}/restart`, { method: 'POST' });
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? shared('http.failure', { status: response.status }));
      return;
    }

    setRestarting(null);
    toast({ title: t('restart.toast', { app: app.applicationSlug }), tone: 'accent' });
    // The restart publishes its progress on the application's stream: we take the
    // user there rather than leave them guessing.
    onOpen(app.id);
  }

  return (
    <>
      <Table dense label={t('column.application')}>
        <TableHeader>
          <TableRow>
            <TableHead>{t('column.application')}</TableHead>
            <TableHead>{shared('column.state')}</TableHead>
            <TableHead>{t('column.uptime')}</TableHead>
            <TableActionsHead>
              <span className="sr-only">{shared('column.actions')}</span>
            </TableActionsHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((app) => (
            <TableRow key={app.id}>
              <TableCell>
                <span className="flex min-w-0 flex-col">
                  <Link
                    href={`/apps?app=${app.id}`}
                    scroll={false}
                    className="cellname w-fit hover:underline"
                    onClick={(event) => {
                      event.preventDefault();
                      onOpen(app.id);
                    }}
                  >
                    {app.applicationSlug}
                  </Link>
                  <span className="mono t-cap truncate text-text-3">
                    {app.url ? (
                      <a
                        href={app.url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {app.url.replace(/^https?:\/\//, '')}
                      </a>
                    ) : app.publishedPort ? (
                      `${app.targetHost}:${app.publishedPort}`
                    ) : (
                      `v${app.version} · ${app.runtime}`
                    )}
                  </span>
                </span>
              </TableCell>

              <TableCell>
                <span className="flex flex-col items-start gap-1">
                  <HealthDot health={app.healthStatus} />
                  {app.status === 'rolled_back' ? (
                    <Badge variant="warn">{t('row.restored')}</Badge>
                  ) : null}
                  {app.lastFailedUpdate ? (
                    <span className="flex flex-col items-start gap-0.5">
                      <Link href={`/deployments?run=${app.lastFailedUpdate.deploymentId}`}>
                        <Badge variant="danger" dot>
                          {t('row.updateFailed')}
                        </Badge>
                      </Link>
                      <span className="t-cap text-text-3">
                        v{app.lastFailedUpdate.version}
                        {app.lastFailedUpdate.failedStep
                          ? t('row.failedStep', { step: app.lastFailedUpdate.failedStep })
                          : ''}
                        {app.lastFailedUpdate.mayHaveReplacedServices ? t('row.replaced') : ''}
                      </span>
                    </span>
                  ) : null}
                </span>
              </TableCell>

              <TableCell className="num text-text-3">{formatSince(app.startedAt, t)}</TableCell>

              <TableActions>
                <span className="inline-flex items-center gap-1.5">
                  <Button asChild size="sm" variant="secondary">
                    <Link
                      href={`/apps?app=${app.id}`}
                      scroll={false}
                      onClick={(event) => {
                        event.preventDefault();
                        onOpen(app.id);
                      }}
                    >
                      <ScrollText aria-hidden />
                      {t('action.logs')}
                    </Link>
                  </Button>
                  {canRestart ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setError(null);
                        setRestarting(app);
                      }}
                    >
                      {t('action.restart')}
                    </Button>
                  ) : null}
                </span>
              </TableActions>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={restarting !== null}
        onOpenChange={(open) => (open ? undefined : setRestarting(null))}
        level="reversible"
        icon={<RotateCw />}
        title={
          restarting
            ? t('restart.dialog.title', {
                app: restarting.applicationSlug,
                target: restarting.targetName,
              })
            : ''
        }
        consequences={[t('restart.consequence.images'), t('restart.consequence.downtime')]}
        confirmLabel={t('action.restart')}
        pendingLabel={t('action.restart.busy')}
        pending={busy}
        error={error}
        onConfirm={() => (restarting ? restart(restarting) : undefined)}
      />
    </>
  );
}
