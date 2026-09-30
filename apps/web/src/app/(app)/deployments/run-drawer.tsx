'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Rocket, ScrollText, Undo2 } from 'lucide-react';
import { SCANNERS, type DeploymentStatus } from '@pupitre/core';
import { CommitRef } from '@/components/commit-ref';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { KeyValue } from '@/components/ui/data';
import {
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerSection,
} from '@/components/ui/drawer';
import { Skeleton } from '@/components/ui/skeleton';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { appConsole } from '@/i18n/messages/console';
import { deployments as messages } from '@/i18n/messages/deployments';
import { sources } from '@/i18n/messages/sources';
import type { FormatSettings } from '@/lib/format';
import { toast } from '@/lib/toast';
import { VerdictBadge, worstOf, type DeploymentRow } from './deployments-table';
import { PipelineSteps, type StepView } from './pipeline-steps';
import { DeploymentStatusBadge, formatDate, formatDuration } from './status-badge';

/** Ce que rend `GET /api/deployments/{id}` et dont l'aperçu se sert. */
type RunDetail = {
  id: string;
  status: DeploymentStatus;
  previousDeploymentId: string | null;
  steps: Array<StepView & { startedAt: string | null; finishedAt: string | null }>;
};

type ApiError = { error?: { message?: string } };

/** Un run qui tourne encore se relit à cette cadence tant que l'aperçu est ouvert. */
const POLL_MS = 3_000;

const ROLLBACKABLE: readonly DeploymentStatus[] = ['success', 'failed', 'rolled_back'];

/**
 * L'aperçu d'un run : ses étapes, le verdict de ses scans, son contexte. La
 * trace complète — logs, findings, AppSpec figée — reste la page du run, à un
 * clic ou à Entrée.
 */
export function RunDrawer({
  row,
  onOpenChange,
  onPrevious,
  onNext,
  canRollback,
  format,
}: {
  row: DeploymentRow | null;
  onOpenChange: (open: boolean) => void;
  onPrevious?: () => void;
  onNext?: () => void;
  canRollback: boolean;
  format: FormatSettings;
}) {
  return (
    <Drawer
      open={row !== null}
      onOpenChange={onOpenChange}
      onPrevious={onPrevious}
      onNext={onNext}
      recordHref={row ? `/deployments/${row.id}` : undefined}
    >
      {/* Une clé par run : passer d'une ligne à l'autre repart d'un état vierge. */}
      {row ? (
        <RunDrawerContent key={row.id} row={row} canRollback={canRollback} format={format} />
      ) : null}
    </Drawer>
  );
}

function RunDrawerContent({
  row,
  canRollback,
  format,
}: {
  row: DeploymentRow;
  canRollback: boolean;
  format: FormatSettings;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const ts = useT(sources);
  const tConsole = useT(appConsole);
  const router = useRouter();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const read = async () => {
      const response = await fetch(`/api/deployments/${row.id}`, { cache: 'no-store' });
      if (cancelled) return;
      if (!response.ok) {
        setError(t('drawer.failed', { status: response.status }));
        return;
      }
      const body = (await response.json()) as RunDetail;
      if (cancelled) return;
      setDetail(body);
      // Un run en cours avance sous les yeux : on le relit, sans flux dédié.
      if (body.status === 'running' || body.status === 'pending') {
        timer = setTimeout(() => void read(), POLL_MS);
      }
    };
    void read();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [row.id, t]);

  async function rollback() {
    setBusy(true);
    setRollbackError(null);
    const response = await fetch(`/api/deployments/${row.id}/rollback`, { method: 'POST' });
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setRollbackError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return;
    }
    setConfirming(false);
    toast({
      title: t('rollback.toast', { slug: row.applicationSlug }),
      tone: 'accent',
      action: { label: tConsole('rollout.trace'), href: `/deployments/${row.id}` },
    });
    router.refresh();
  }

  const status = detail?.status ?? row.status;
  const worst = row.scan ? worstOf(row.scan.counts) : null;
  const rollbackable =
    canRollback && ROLLBACKABLE.includes(status) && Boolean(detail?.previousDeploymentId);

  return (
    <>
      <DrawerHeader
        icon={<Rocket />}
        kind={t('drawer.kind')}
        route={`/deployments/${row.id}`}
        title={
          <>
            {row.applicationSlug}{' '}
            <span className="mono text-[16px] font-normal text-text-3">#{row.number}</span>
          </>
        }
        state={
          <>
            <DeploymentStatusBadge status={status} />
            <span className="text-text-2">
              <span className="mono">{row.targetName}</span> · {row.runtime} ·{' '}
              {formatDuration(row.startedAt, row.finishedAt)}
            </span>
            <span className="t-cap mono ml-auto text-text-3">
              {formatDate(row.createdAt, format)}
            </span>
          </>
        }
      />

      <DrawerBody>
        <DrawerSection title={t('drawer.pipeline')}>
          {error ? (
            <Alert variant="destructive">{error}</Alert>
          ) : detail === null ? (
            <div className="flex flex-col gap-3" aria-label={t('drawer.loading')}>
              {[0, 1, 2, 3, 4].map((slot) => (
                <div key={slot} className="flex items-center gap-3">
                  <Skeleton className="size-[22px] rounded-full" />
                  <Skeleton className="sk-t w-40" />
                  <Skeleton className="sk-t ml-auto w-14" />
                </div>
              ))}
            </div>
          ) : (
            <PipelineSteps steps={detail.steps} format={format} />
          )}
        </DrawerSection>

        <DrawerSection title={t('drawer.security')}>
          {row.scan && row.scan.scanners.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <VerdictBadge verdict={row.scan.verdict} />
              <span className="t-sm text-text-2">
                {t('drawer.scan.summary', {
                  scanners: row.scan.scanners.map((key) => SCANNERS[key].label).join(', '),
                  worst: worst ? `${worst.severity} ×${worst.count}` : t('drawer.scan.worstNone'),
                })}
              </span>
            </div>
          ) : (
            <p className="t-sm text-text-3">{t('drawer.scan.none')}</p>
          )}
        </DrawerSection>

        <DrawerSection title={t('drawer.context')}>
          <KeyValue
            items={[
              {
                term: t('drawer.application'),
                value: <span className="mono">{row.applicationSlug}</span>,
              },
              { term: t('drawer.target'), value: <span className="mono">{row.targetName}</span> },
              { term: t('drawer.runtime'), value: row.runtime },
              ...(row.source
                ? [{ term: ts('run.source'), value: <CommitRef source={row.source} /> }]
                : []),
              {
                term: t('field.by'),
                value: <span className="mono">{row.triggeredByEmail ?? tc('none')}</span>,
              },
              { term: t('field.duration'), value: formatDuration(row.startedAt, row.finishedAt) },
              {
                term: t('drawer.date'),
                value: <span className="mono">{formatDate(row.createdAt, format)}</span>,
              },
              ...(row.url
                ? [
                    {
                      term: t('field.address'),
                      value: (
                        <a href={row.url} target="_blank" rel="noreferrer" className="link mono">
                          {row.url.replace(/^https?:\/\//, '')}
                        </a>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </DrawerSection>
      </DrawerBody>

      <DrawerFooter end={null}>
        <Button asChild>
          <Link href={`/deployments/${row.id}`}>
            <ScrollText aria-hidden />
            {t('drawer.openTrace')}
          </Link>
        </Button>
        {rollbackable ? (
          <Button
            variant="secondary"
            onClick={() => {
              setRollbackError(null);
              setConfirming(true);
            }}
          >
            <Undo2 aria-hidden />
            {t('action.rollback')}
          </Button>
        ) : null}
      </DrawerFooter>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        level="reversible"
        icon={<Undo2 />}
        tone="accent"
        title={t('rollback.title')}
        description={t('rollback.lead', { slug: row.applicationSlug, target: row.targetName })}
        consequences={[
          tConsole('rollback.noRebuild'),
          tConsole('rollback.status'),
          tConsole('rollback.volumes'),
        ]}
        confirmLabel={tConsole('rollback.confirm')}
        pendingLabel={t('action.rollback.pending')}
        pending={busy}
        error={rollbackError}
        onConfirm={rollback}
      />
    </>
  );
}
