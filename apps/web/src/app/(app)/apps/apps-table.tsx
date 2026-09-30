'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { translator, type DeploymentStatus, type Translate } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { cn } from '@/lib/utils';

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

/**
 * Voyant de lien : la forme porte l'information autant que la couleur.
 *
 * `label` permet de réemployer le même voyant pour l'état d'une **machine**,
 * dont le vocabulaire n'est pas celui d'une application — « opérationnelle »
 * plutôt que « en marche ». Un seul voyant dans tout l'écran de supervision,
 * donc une seule convention de lecture à apprendre.
 */
export function HealthDot({ health, label }: { health: HealthStatus; label?: string }) {
  const t = useT(servers);
  const tone = {
    healthy: 'bg-ok',
    unhealthy: 'bg-warn',
    unreachable: 'bg-danger',
    unknown: 'bg-text-3',
  }[health];

  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn('inline-block size-2 shrink-0 rounded-full', tone)} aria-hidden="true" />
      <span className="text-xs">{label ?? t(HEALTH_KEY[health])}</span>
    </span>
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
 * La colonne « Cible » a disparu : elle répétait à chaque ligne ce que le
 * dépliant qui contient la table annonce déjà une fois. La table ne s'enveloppe
 * plus d'une `Card` non plus — c'est le panneau du serveur qui porte la
 * surface, sinon on empile deux cadres pour une seule information.
 */
export function AppsTable({
  items,
  canRestart,
}: {
  items: SupervisedRow[];
  canRestart: boolean;
}) {
  const t = useT(servers);
  const shared = useT(common);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function restart(app: SupervisedRow) {
    if (
      !window.confirm(
        `${t('restart.confirm', {
          app: app.applicationSlug,
          target: app.targetName,
        })}\n\n${t('restart.confirm.detail')}`,
      )
    ) {
      return;
    }

    setBusy(app.id);
    setError(null);

    const response = await fetch(`/api/apps/${app.id}/restart`, { method: 'POST' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? shared('http.failure', { status: response.status }));
      setBusy(null);
      return;
    }

    // Le redémarrage publie sa progression sur le flux de l'application :
    // on y emmène l'utilisateur plutôt que de le laisser deviner.
    router.push(`/apps/${app.id}`);
  }

  return (
    <div className="space-y-3">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('column.application')}</TableHead>
            <TableHead>{shared('column.state')}</TableHead>
            <TableHead>{t('column.uptime')}</TableHead>
            <TableHead>{t('column.address')}</TableHead>
            <TableActionsHead>{shared('column.actions')}</TableActionsHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((app) => (
            <TableRow key={app.id}>
              <TableCell>
                <Link
                  href={`/apps/${app.id}`}
                  className="text-sm font-medium underline-offset-4 hover:underline"
                >
                  {app.applicationSlug}
                </Link>
                <div className="text-text-3 font-mono text-xs">
                  v{app.version} · {t('row.services', { count: app.services.length })} ·{' '}
                  {app.runtime}
                </div>
              </TableCell>

              <TableCell>
                <HealthDot health={app.healthStatus} />
                {app.status === 'rolled_back' ? (
                  <Badge variant="warn" className="mt-1 text-[10px]">
                    {t('row.restored')}
                  </Badge>
                ) : null}
                {app.lastFailedUpdate ? (
                  <div className="mt-1">
                    <Link href={`/deployments/${app.lastFailedUpdate.deploymentId}`}>
                      <Badge variant="destructive" className="text-[10px]">
                        {t('row.updateFailed')}
                      </Badge>
                    </Link>
                    <div className="text-text-3 mt-1 text-[10px]">
                      v{app.lastFailedUpdate.version}
                      {app.lastFailedUpdate.failedStep
                        ? t('row.failedStep', { step: app.lastFailedUpdate.failedStep })
                        : ''}
                      {app.lastFailedUpdate.mayHaveReplacedServices ? t('row.replaced') : ''}
                    </div>
                  </div>
                ) : null}
              </TableCell>

              <TableCell className="font-mono text-xs">
                {formatSince(app.startedAt, t)}
              </TableCell>

              <TableCell className="font-mono text-xs">
                {app.url ? (
                  <a href={app.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                    {app.url.replace(/^https?:\/\//, '')}
                  </a>
                ) : (
                  <span className="text-text-3">—</span>
                )}
              </TableCell>

              <TableActions className="space-x-2 whitespace-nowrap">
                <Button asChild size="sm" variant="outline">
                  <Link href={`/apps/${app.id}`}>{t('action.logs')}</Link>
                </Button>
                {canRestart ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === app.id}
                    onClick={() => void restart(app)}
                  >
                    {busy === app.id ? t('action.restart.busy') : t('action.restart')}
                  </Button>
                ) : null}
              </TableActions>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
