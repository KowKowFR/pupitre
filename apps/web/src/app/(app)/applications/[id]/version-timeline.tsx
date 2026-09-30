'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, Minus, RotateCcw, X } from 'lucide-react';
import type { DeploymentStatus } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { applications as messages } from '@/i18n/messages/applications';
import type { FormatSettings } from '@/lib/format';
import { toast } from '@/lib/toast';
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

export type RedeployTarget = { id: string; name: string; runtimes: string[] };

type ApiError = { error?: { message?: string } };

const STEP_CLASS: Partial<Record<DeploymentStatus, string>> = {
  success: 'done',
  failed: 'fail',
  rolled_back: 'fail',
  running: 'run',
  pending: 'run',
  destroyed: 'skip',
};

/**
 * L'historique des versions, en pipeline vertical : chaque déploiement fige
 * son AppSpec au départ, et c'est ce qui le rend rejouable — sur la même cible
 * ou sur une autre qui sait le même runtime.
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
  format: FormatSettings;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<VersionRow | null>(null);

  // La cible retenue : celle choisie dans la liste, sinon la cible d'origine —
  // ramenée à la première cible éligible si celle-là ne sait pas le runtime.
  const targetOf = (version: VersionRow) => {
    const eligible = targets.filter((target) => target.runtimes.includes(version.runtime));
    const chosen = selection[version.deploymentId] ?? version.targetId;
    return eligible.some((target) => target.id === chosen) ? chosen : (eligible[0]?.id ?? chosen);
  };
  const labelOf = (version: VersionRow) => version.appVersion ?? `v${version.version}`;

  async function redeploy(version: VersionRow) {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/applications/${applicationId}/redeploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: version.deploymentId, targetId: targetOf(version) }),
    });
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      setConfirming(null);
      return;
    }
    const { id, number } = (await response.json()) as { id: string; number: number };
    setConfirming(null);
    toast({
      title: t('redeploy.toast', { slug: applicationSlug, version: labelOf(version) }),
      description: t('toast.deployed.detail', { number }),
      tone: 'accent',
      action: { label: t('toast.follow'), href: `/deployments/${id}` },
    });
    router.refresh();
  }

  if (versions.length === 0) {
    return <p className="t-sm text-text-3">{t('versions.never')}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <ol className="steps">
        {versions.map((version) => {
          const step = STEP_CLASS[version.status] ?? '';
          // Une version ne se rejoue que sur une cible qui sait son runtime.
          const eligible = targets.filter((target) => target.runtimes.includes(version.runtime));
          return (
            <li key={version.deploymentId} className={cn('step', step)}>
              <span className="dot" aria-hidden>
                {step === 'done' ? (
                  <Check />
                ) : step === 'fail' ? (
                  <X />
                ) : step === 'run' ? (
                  <span className="spinner" />
                ) : step === 'skip' ? (
                  <Minus />
                ) : null}
              </span>
              <div className="body gap-1.5 pb-1">
                <div className="ttl flex-wrap">
                  <Link href={`/deployments/${version.deploymentId}`} className="mono hover:underline">
                    v{version.version}
                  </Link>
                  <span className="mono text-text-2">{version.appVersion ?? tc('none')}</span>
                  <DeploymentStatusBadge status={version.status} />
                  <span className="mono t-cap text-text-3">
                    {version.targetName} · {version.runtime}
                    {version.publishedPort ? ` · ${version.publishedPort}` : ''}
                  </span>
                  <span className="tm">{formatDate(version.createdAt, format)}</span>
                </div>
                <div className="t-cap flex flex-wrap gap-x-3 text-text-3">
                  {version.triggeredByEmail ? <span>{version.triggeredByEmail}</span> : null}
                  {version.imageTag ? (
                    <span className="mono truncate">{version.imageTag}</span>
                  ) : null}
                  {version.url ? (
                    <a href={version.url} target="_blank" rel="noreferrer" className="link mono">
                      {version.url}
                    </a>
                  ) : null}
                </div>
                {canRedeploy && version.redeployable && eligible.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Select
                      className="input-sm w-48"
                      aria-label={t('drawer.deploy.target')}
                      value={targetOf(version)}
                      onChange={(event) =>
                        setSelection((current) => ({ ...current, [version.deploymentId]: event.target.value }))
                      }
                    >
                      {eligible.map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.name}
                        </option>
                      ))}
                    </Select>
                    <Button size="sm" variant="secondary" onClick={() => setConfirming(version)}>
                      <RotateCcw aria-hidden />
                      {t('redeploy.action')}
                    </Button>
                  </div>
                ) : null}
                {canRedeploy && !version.redeployable ? (
                  <p className="t-cap text-text-3">{t('redeploy.impossible')}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => (open ? undefined : setConfirming(null))}
        level="reversible"
        icon={<RotateCcw />}
        title={
          confirming
            ? t('redeploy.dialog.title', {
                slug: applicationSlug,
                version: labelOf(confirming),
                target: targets.find((target) => target.id === targetOf(confirming))?.name ??
                  t('redeploy.chosenTarget'),
              })
            : ''
        }
        consequences={[
          t('redeploy.consequence.frozen'),
          t('redeploy.consequence.current'),
          t('redeploy.consequence.run'),
        ]}
        confirmLabel={t('redeploy.action')}
        pendingLabel={t('action.sending')}
        pending={busy}
        onConfirm={() => (confirming ? redeploy(confirming) : undefined)}
      />
    </div>
  );
}
