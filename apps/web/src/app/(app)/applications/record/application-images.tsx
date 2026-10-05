'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowUpCircle, RefreshCw } from 'lucide-react';
import { shortDigest, type ImageUpdateStatus } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useT } from '@/i18n/client';
import { applications as messages } from '@/i18n/messages/applications';
import { common } from '@/i18n/messages/common';
import { toast } from '@/lib/toast';

/**
 * The application's images, compared with their registries.
 *
 * Two possible pieces of news, which do not call for the same gesture: a
 * **republished** tag (`postgres:16` designates another content) is caught up by
 * redeploying the version in service, without changing anything else — that is
 * the "Update" button; a **more recent tag** (`16.6` after `16.4`) is a change to
 * the AppSpec, which the screen points out without making it.
 */

export type ImageRowView = {
  targetId: string;
  targetName: string;
  deploymentId: string | null;
  service: string;
  image: string;
  status: ImageUpdateStatus;
  runningDigest: string | null;
  latestDigest: string | null;
  newerTag: string | null;
  nextMajorTag: string | null;
  error: string | null;
};

type ApiError = { error?: { message?: string } };

const STATUS_VARIANT: Record<ImageUpdateStatus, 'ok' | 'warn' | 'idle' | 'outline'> = {
  current: 'ok',
  outdated: 'warn',
  unknown: 'idle',
  pinned: 'outline',
};

const KNOWN_ERRORS = [
  'unauthorized',
  'not_found',
  'rate_limited',
  'unreachable',
  'unexpected',
  'target_unreachable',
  'not_running',
] as const;
type KnownError = (typeof KNOWN_ERRORS)[number];
const isKnownError = (code: string | null): code is KnownError =>
  code !== null && (KNOWN_ERRORS as readonly string[]).includes(code);

export function ApplicationImages({
  applicationId,
  applicationSlug,
  rows,
  checkable,
  checkedAt,
  checkedAgo,
  canDeploy,
}: {
  applicationId: string;
  applicationSlug: string;
  rows: ImageRowView[];
  /** Services whose image comes from a registry. Zero: everything is built on the target. */
  checkable: number;
  /** The most recent of the findings: when it changes, the requested check has come back. */
  checkedAt: string | null;
  checkedAgo: string | null;
  canDeploy: boolean;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ImageRowView | null>(null);

  // The finding changed under our feet: the requested check has come back.
  const [seenCheck, setSeenCheck] = useState(checkedAt);
  if (seenCheck !== checkedAt) {
    setSeenCheck(checkedAt);
    setChecking(false);
  }

  async function check() {
    setChecking(true);
    setError(null);
    const response = await fetch(`/api/applications/${applicationId}/images/check`, {
      method: 'POST',
    }).catch(() => null);
    if (!response?.ok) {
      const body = response ? ((await response.json().catch(() => ({}))) as ApiError) : {};
      setError(body.error?.message ?? tc('http.failure', { status: response?.status ?? 0 }));
      setChecking(false);
      return;
    }
    // The result comes back through the `applications` signal, which refreshes the
    // page; the button frees itself after a while if it does not arrive.
    toast({ title: t('images.check.queued'), tone: 'accent' });
    window.setTimeout(() => setChecking(false), 20_000);
  }

  async function update(row: ImageRowView) {
    if (!row.deploymentId) return;
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/applications/${applicationId}/redeploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: row.deploymentId, targetId: row.targetId }),
    }).catch(() => null);
    setBusy(false);
    setConfirming(null);
    if (!response?.ok) {
      const body = response ? ((await response.json().catch(() => ({}))) as ApiError) : {};
      setError(body.error?.message ?? tc('http.failure', { status: response?.status ?? 0 }));
      return;
    }
    const { id, number } = (await response.json()) as { id: string; number: number };
    toast({
      title: t('images.update.toast', { slug: applicationSlug, target: row.targetName }),
      description: t('toast.deployed.detail', { number }),
      tone: 'accent',
      action: { label: t('toast.follow'), href: `/deployments?run=${id}` },
    });
    router.refresh();
  }

  const outdated = rows.filter((row) => row.status === 'outdated');
  const targets = new Set(rows.map((row) => row.targetId));

  return (
    <Card>
      <CardHeader
        actions={
          checkable > 0 ? (
            <Button variant="secondary" size="sm" loading={checking} onClick={() => void check()}>
              {checking ? null : <RefreshCw aria-hidden />}
              {checking ? t('images.checking') : t('images.check')}
            </Button>
          ) : null
        }
      >
        <CardTitle>{t('images.title')}</CardTitle>
        <CardDescription>
          {checkable === 0
            ? t('images.built')
            : checkedAgo
              ? t('images.description.checked', { ago: checkedAgo })
              : t('images.description.never')}
        </CardDescription>
      </CardHeader>

      {checkable > 0 && (rows.length > 0 || error) ? (
        <CardContent className="flex flex-col gap-3">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          {outdated.length > 0 ? (
            <Alert variant="warn" title={t('images.outdated.title', { count: outdated.length })}>
              {t('images.outdated.body')}
            </Alert>
          ) : null}

          <ul className="flex flex-col divide-y divide-border-subtle">
            {rows.map((row) => (
              <li
                key={`${row.targetId}:${row.service}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="mono text-[12.5px] font-semibold">{row.service}</span>
                    <span className="mono truncate text-[12px] text-text-2">{row.image}</span>
                    {targets.size > 1 ? (
                      <span className="t-cap text-text-3">
                        {t('images.onTarget', { target: row.targetName })}
                      </span>
                    ) : null}
                  </span>
                  {row.status === 'outdated' ? (
                    <span className="mono t-cap text-text-3">
                      {t('images.digests', {
                        running: shortDigest(row.runningDigest) ?? '—',
                        latest: shortDigest(row.latestDigest) ?? '—',
                      })}
                    </span>
                  ) : row.status === 'unknown' ? (
                    <span className="t-cap text-text-3">
                      {isKnownError(row.error)
                        ? t(`images.error.${row.error}`)
                        : t('images.error.unexpected')}
                    </span>
                  ) : null}
                </div>

                <span className="flex flex-wrap items-center gap-1.5">
                  {row.newerTag ? (
                    <Badge variant="accent">{t('images.newer', { tag: row.newerTag })}</Badge>
                  ) : null}
                  {row.nextMajorTag ? (
                    <Badge variant="outline">{t('images.major', { tag: row.nextMajorTag })}</Badge>
                  ) : null}
                  <Badge variant={STATUS_VARIANT[row.status]} dot>
                    {t(`images.status.${row.status}`)}
                  </Badge>
                </span>

                {row.status === 'outdated' && canDeploy && row.deploymentId ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setConfirming(row)}
                  >
                    <ArrowUpCircle aria-hidden />
                    {t('images.update')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => (open ? undefined : setConfirming(null))}
        level="reversible"
        title={
          confirming
            ? t('images.update.title', { slug: applicationSlug, target: confirming.targetName })
            : ''
        }
        consequences={[
          t('images.update.same'),
          t('images.update.pull'),
          t('images.update.pipeline'),
        ]}
        confirmLabel={t('images.update')}
        onConfirm={() => (confirming ? update(confirming) : undefined)}
      />
    </Card>
  );
}
