'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
 * La dernière tentative de mise à jour, quand elle a échoué.
 *
 * Sa présence est ce qui distingue « cette application tourne » de « cette
 * application tourne, mais pas dans la version qu'on a voulu y mettre ». La
 * faire disparaître de l'écran était le défaut : une application vivante
 * devenait invisible dès qu'un déploiement ratait derrière elle.
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
 * Voyant de lien : la forme porte l'information autant que la couleur.
 *
 * `label` permet de réemployer le même voyant pour l'état d'une **machine**,
 * dont le vocabulaire n'est pas celui d'une application — « opérationnelle »
 * plutôt que « en marche ». Un seul voyant dans tout l'écran de supervision,
 * donc une seule convention de lecture à apprendre.
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
 * Le français, figé, pour les appelants qui n'ont pas encore de `t` sous la
 * main — les écrans de supervision de sites importent cette fonction et sont
 * traduits à part. Ils obtiennent exactement la chaîne d'avant tant qu'ils ne
 * passent rien ; le jour où ils passent leur `t`, la fonction suit.
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
 * Les applications supervisées d'**un** serveur.
 *
 * La colonne « Cible » a disparu : elle répétait à chaque ligne ce que la carte
 * qui contient la table annonce déjà une fois. La table ne s'enveloppe plus
 * d'une carte non plus — c'est la carte du serveur qui porte la surface, sinon
 * on empile deux cadres pour une seule information.
 */
export function AppsTable({ items, canRestart }: { items: SupervisedRow[]; canRestart: boolean }) {
  const t = useT(servers);
  const shared = useT(common);
  const router = useRouter();
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
    // Le redémarrage publie sa progression sur le flux de l'application :
    // on y emmène l'utilisateur plutôt que de le laisser deviner.
    router.push(`/apps/${app.id}`);
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
                  <Link href={`/apps/${app.id}`} className="cellname w-fit hover:underline">
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
                      <Link href={`/deployments/${app.lastFailedUpdate.deploymentId}`}>
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
                    <Link href={`/apps/${app.id}`}>
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
