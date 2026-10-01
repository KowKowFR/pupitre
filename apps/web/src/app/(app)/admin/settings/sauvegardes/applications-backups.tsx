'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { BackupHistory, formatBytes, type BackupRun } from '@/components/backups/backup-history';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useT } from '@/i18n/client';
import { backups as messages } from '@/i18n/messages/backups';
import { common } from '@/i18n/messages/common';
import type { ApplicationBackupsView } from '@/lib/backups';
import { formatDateTime, type FormatSettings } from '@/lib/format';
import { toast } from '@/lib/toast';

/**
 * Les applications sauvegardées, chacune dépliable sur son historique : de quoi
 * retrouver la sauvegarde du 7 et la restaurer sans passer par chaque fiche.
 * Les sauvegardes d'une application supprimée y restent visibles — elles sont
 * encore sur la destination, et c'est le seul endroit où les voir.
 */

type ApiError = { error?: { message?: string } };

const STATUS_VARIANT = { running: 'accent', success: 'ok', failed: 'danger' } as const;

export function ApplicationsBackups({
  applications,
  targetNames,
  canRestore,
  canManage,
  format,
}: {
  applications: ApplicationBackupsView[];
  targetNames: Record<string, string>;
  canRestore: boolean;
  canManage: boolean;
  format: FormatSettings;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  // Une sauvegarde en cours, n'importe où : on relit jusqu'à son issue.
  const running = applications.some((application) =>
    application.items.some((item) => item.status === 'running'),
  );
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => router.refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [running, router]);

  const run: BackupRun = async (url, init, done, detail) => {
    setError(null);
    const response = await fetch(url, {
      headers: { 'content-type': 'application/json' },
      ...init,
    }).catch(() => null);
    if (!response?.ok) {
      const body = response ? ((await response.json().catch(() => ({}))) as ApiError) : {};
      setError(body.error?.message ?? tc('http.failure', { status: response?.status ?? 0 }));
      return false;
    }
    toast({ title: done, ...(detail ? { description: detail } : {}), tone: 'ok' });
    router.refresh();
    return true;
  };

  if (applications.length === 0) {
    return <p className="t-sm text-text-3">{t('apps.list.empty')}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border">
        {applications.map((application) => {
          const last = application.items[0];
          const succeeded = application.items.filter((item) => item.status === 'success');
          const total = succeeded.reduce((sum, item) => sum + item.bytes, 0);
          const busy = application.items.some((item) => item.status === 'running');
          const deleted = application.id === null;
          const live = application.targets.filter((target) => !target.stopped);
          return (
            <li key={application.id ?? `deleted:${application.slug}`}>
              <Collapsible>
                <div className="flex flex-col gap-1 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <CollapsibleTrigger className="t-sm font-medium text-text">
                      {application.name}
                    </CollapsibleTrigger>
                    {deleted ? <Badge variant="idle">{t('apps.list.deleted')}</Badge> : null}
                    <span className="flex flex-1 flex-wrap items-center justify-end gap-2">
                      {application.policy?.enabled ? (
                        <Badge variant="accent">{t('apps.list.auto')}</Badge>
                      ) : null}
                      {application.policy?.beforeDeploy ? (
                        <Badge variant="accent">{t('apps.list.beforeDeploy')}</Badge>
                      ) : null}
                      {application.policy ? (
                        <Badge variant="idle">{t(`mode.${application.policy.mode}`)}</Badge>
                      ) : null}
                      {application.id ? (
                        <Link href={`/applications/${application.id}`} className="link t-cap">
                          {t('apps.list.open')}
                        </Link>
                      ) : null}
                    </span>
                  </div>
                  {/* Sous le nom, aligné sur lui : la dernière sauvegarde et le total. */}
                  <div className="t-cap flex flex-wrap items-center gap-x-2 gap-y-1 pl-5.5 text-text-3">
                    {last ? (
                      <>
                        <Badge variant={STATUS_VARIANT[last.status]} dot>
                          {last.status === 'running' ? (
                            <LoaderCircle aria-hidden className="size-3 animate-spin" />
                          ) : null}
                          {t(`status.${last.status}`)}
                        </Badge>
                        <span className="mono" title={last.startedAt}>
                          {t('apps.list.last', { date: formatDateTime(last.startedAt, format) })}
                        </span>
                        <span>
                          {t('apps.list.count', { count: succeeded.length })}
                          {succeeded.length > 0 ? ` · ${formatBytes(total)}` : ''}
                        </span>
                      </>
                    ) : (
                      <span>{t('apps.list.never')}</span>
                    )}
                  </div>
                </div>
                <CollapsiblePanel className="flex flex-col gap-2 px-3 pb-3">
                  {deleted ? (
                    <p className="t-cap text-text-3">{t('apps.list.deleted.help')}</p>
                  ) : application.targets.length === 0 ? (
                    <p className="t-cap text-text-3">{t('apps.list.notDeployed')}</p>
                  ) : live.length === 0 ? (
                    <p className="t-cap text-text-3">{t('apps.list.stopped')}</p>
                  ) : null}
                  {application.lastRestore ? (
                    <p
                      className={
                        application.lastRestore.ok ? 't-cap text-text-2' : 't-cap text-danger-text'
                      }
                    >
                      {application.lastRestore.ok
                        ? t('lastRestore.ok', {
                            date: formatDateTime(application.lastRestore.at, format),
                            who: application.lastRestore.actorName
                              ? t('lastRestore.who', { name: application.lastRestore.actorName })
                              : '',
                          })
                        : t('lastRestore.failed', {
                            date: formatDateTime(application.lastRestore.at, format),
                            error: application.lastRestore.error ?? '—',
                          })}
                    </p>
                  ) : null}
                  <BackupHistory
                    applicationSlug={application.slug}
                    restorable={!deleted}
                    items={application.items}
                    targets={application.targets}
                    targetNames={targetNames}
                    canRestore={canRestore}
                    canManage={canManage}
                    busy={busy}
                    format={format}
                    run={run}
                  />
                </CollapsiblePanel>
              </Collapsible>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
