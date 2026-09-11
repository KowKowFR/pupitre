'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { DeploymentStatus } from '@tp/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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

const HEALTH_LABEL: Record<HealthStatus, string> = {
  healthy: 'en marche',
  unhealthy: 'répond mal',
  unreachable: 'injoignable',
  unknown: 'état inconnu',
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
  const tone = {
    healthy: 'bg-ok',
    unhealthy: 'bg-warn',
    unreachable: 'bg-danger',
    unknown: 'bg-ink-faint',
  }[health];

  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn('inline-block size-2 shrink-0 rounded-full', tone)} aria-hidden="true" />
      <span className="text-xs">{label ?? HEALTH_LABEL[health]}</span>
    </span>
  );
}

export function formatSince(iso: string | null): string {
  if (!iso) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} j`;
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
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function restart(app: SupervisedRow) {
    if (
      !window.confirm(
        `Redémarrer « ${app.applicationSlug} » sur ${app.targetName} ?\n\n` +
          'Les conteneurs sont relancés avec les mêmes images et les mêmes volumes. ' +
          "L'application sera brièvement indisponible.",
      )
    ) {
      return;
    }

    setBusy(app.id);
    setError(null);

    const response = await fetch(`/api/apps/${app.id}/restart`, { method: 'POST' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
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
            <TableHead>Application</TableHead>
            <TableHead>État</TableHead>
            <TableHead>En ligne depuis</TableHead>
            <TableHead>Adresse</TableHead>
            <TableHead className="text-right">Actions</TableHead>
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
                <div className="text-ink-faint font-mono text-xs">
                  v{app.version} · {app.services.length} service
                  {app.services.length > 1 ? 's' : ''} · {app.runtime}
                </div>
              </TableCell>

              <TableCell>
                <HealthDot health={app.healthStatus} />
                {app.status === 'rolled_back' ? (
                  <Badge variant="warn" className="mt-1 text-[10px]">
                    version restaurée
                  </Badge>
                ) : null}
                {app.lastFailedUpdate ? (
                  <div className="mt-1">
                    <Link href={`/deployments/${app.lastFailedUpdate.deploymentId}`}>
                      <Badge variant="destructive" className="text-[10px]">
                        dernière mise à jour échouée
                      </Badge>
                    </Link>
                    <div className="text-ink-faint mt-1 text-[10px]">
                      v{app.lastFailedUpdate.version}
                      {app.lastFailedUpdate.failedStep
                        ? ` · étape ${app.lastFailedUpdate.failedStep}`
                        : ''}
                      {app.lastFailedUpdate.mayHaveReplacedServices
                        ? ' · les conteneurs ont pu être remplacés'
                        : ''}
                    </div>
                  </div>
                ) : null}
              </TableCell>

              <TableCell className="font-mono text-xs">{formatSince(app.startedAt)}</TableCell>

              <TableCell className="font-mono text-xs">
                {app.url ? (
                  <a href={app.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                    {app.url.replace(/^https?:\/\//, '')}
                  </a>
                ) : (
                  <span className="text-ink-faint">—</span>
                )}
              </TableCell>

              <TableCell className="space-x-2 text-right">
                <Button asChild size="sm" variant="outline">
                  <Link href={`/apps/${app.id}`}>Logs</Link>
                </Button>
                {canRestart ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === app.id}
                    onClick={() => void restart(app)}
                  >
                    {busy === app.id ? 'Envoi…' : 'Redémarrer'}
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
