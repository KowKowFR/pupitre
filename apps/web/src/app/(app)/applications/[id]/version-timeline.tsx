'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { DeploymentStatus } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { applications as messages } from '@/i18n/messages/applications';
import type { FormatSettings } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DeploymentStatusBadge, formatDate } from '../../deployments/status-badge';

export type VersionRow = {
  deploymentId: string;
  version: number;
  appVersion: string | null;
  imageTag: string | null;
  runtime: string;
  status: DeploymentStatus;
  url: string | null;
  publishedPort: number | null;
  targetId: string;
  targetName: string;
  triggeredByEmail: string | null;
  createdAt: string;
  finishedAt: string | null;
  redeployable: boolean;
};

export type RedeployTarget = { id: string; name: string };

type ApiError = { error?: { message?: string } };

/**
 * Timeline des versions déployées.
 *
 * Chaque ligne est un déploiement — il n'y a pas d'autre notion de « version »
 * dans le modèle. Le bouton rejoue l'AppSpec figée à l'époque : ce n'est pas un
 * rollback (qui remet en service une release déjà sur la cible) mais un
 * déploiement complet, ce qui permet de rejouer une version sur une autre
 * machine, ou après une destruction.
 */
export function VersionTimeline({
  applicationId,
  applicationSlug,
  versions,
  targets,
  canRedeploy,
  format,
}: {
  applicationId: string;
  applicationSlug: string;
  versions: VersionRow[];
  targets: RedeployTarget[];
  canRedeploy: boolean;
  /** Le formatage descend par props : la timeline est cliente, la locale non. */
  format: FormatSettings;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});

  async function redeploy(version: VersionRow) {
    const targetId = selection[version.deploymentId] ?? version.targetId;
    const targetName =
      targets.find((target) => target.id === targetId)?.name ?? t('redeploy.chosenTarget');

    const confirmed = window.confirm(
      t('redeploy.confirm', {
        slug: applicationSlug,
        version: version.appVersion ?? `#${version.version}`,
        target: targetName,
      }),
    );
    if (!confirmed) return;

    setBusy(version.deploymentId);
    setError(null);

    const response = await fetch(`/api/applications/${applicationId}/redeploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: version.deploymentId, targetId }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      setBusy(null);
      return;
    }

    const { id } = (await response.json()) as { id: string };
    router.push(`/deployments/${id}`);
  }

  if (versions.length === 0) {
    return (
      <Card>
        <CardContent className="text-muted-foreground py-10 text-center text-sm">
          {t('versions.never')}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <ol className="relative space-y-0">
          {versions.map((version, index) => (
            <li key={version.deploymentId} className="relative flex gap-4 pb-6 last:pb-0">
              {/* Le trait ne descend pas sous le dernier point : une timeline
                  qui continue dans le vide laisse croire qu'il manque quelque
                  chose. */}
              {index < versions.length - 1 ? (
                <span className="absolute top-4 left-[7px] h-full w-px bg-border-strong/70" />
              ) : null}

              <span
                className={cn(
                  'relative z-10 mt-1.5 size-3.5 shrink-0 rounded-full border-2',
                  version.status === 'success'
                    ? 'border-ok bg-ok'
                    : version.status === 'failed'
                      ? 'border-danger bg-danger'
                      : version.status === 'rolled_back'
                        ? 'border-warn bg-warn'
                        : 'border-border-strong bg-bg',
                )}
              />

              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link
                    href={`/deployments/${version.deploymentId}`}
                    className="text-[0.8125rem] font-medium text-text underline decoration-accent-line underline-offset-4 hover:decoration-accent"
                  >
                    #{version.version}
                  </Link>
                  <span className="font-mono text-xs">{version.appVersion ?? tc('none')}</span>
                  <DeploymentStatusBadge status={version.status} />
                  <span className="text-muted-foreground font-mono text-xs">
                    {version.targetName} · {version.runtime}
                    {version.publishedPort ? ` · port ${version.publishedPort}` : ''}
                  </span>
                </div>

                <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 font-mono text-[11px]">
                  <span>{formatDate(version.createdAt, format)}</span>
                  {version.triggeredByEmail ? <span>{version.triggeredByEmail}</span> : null}
                  {version.imageTag ? <span className="truncate">{version.imageTag}</span> : null}
                  {version.url ? (
                    <a
                      href={version.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4"
                    >
                      {version.url}
                    </a>
                  ) : null}
                </div>

                {canRedeploy && version.redeployable && targets.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Select
                      className="inline-flex h-8 w-44"
                      value={selection[version.deploymentId] ?? version.targetId}
                      onChange={(event) =>
                        setSelection((current) => ({
                          ...current,
                          [version.deploymentId]: event.target.value,
                        }))
                      }
                    >
                      {targets.map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.name}
                        </option>
                      ))}
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void redeploy(version)}
                    >
                      {busy === version.deploymentId
                        ? t('action.sending')
                        : t('redeploy.action')}
                    </Button>
                  </div>
                ) : null}

                {canRedeploy && !version.redeployable ? (
                  <p className="text-muted-foreground text-xs">{t('redeploy.impossible')}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
