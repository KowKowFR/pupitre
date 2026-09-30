import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  countDeploymentsOnTarget,
  getAppSettings,
  getTarget,
  getTargetPortReport,
  HOST_METRIC_CATALOG,
  listTargetSamples,
  targetHistories,
  type MetricSummary,
} from '@pupitre/db';
import type { Translate } from '@pupitre/core';
import { z } from 'zod';
import { Readout, ReadoutBar, type Tone } from '@/components/instrument';
import { PageHeader } from '@/components/page-header';
import { Crumb } from '@/components/shell/breadcrumb';
import { TargetLabelChip, sortedLabelEntries } from '@/components/target-label';
import { RuntimePill } from '@/components/ui/badge';
import { KeyValue } from '@/components/ui/data';
import { State } from '@/components/ui/led';
import { TabLink, Tabs } from '@/components/ui/tabs';
import { getT } from '@/i18n/server';
import { targets as messages } from '@/i18n/messages/targets';
import { formatDateTimeWith, formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { STATUS_TONE } from '../status';
import { PortsPanel } from './ports-panel';
import { ReportDetails } from './report-details';
import { TargetActions } from './target-actions';
import { WorkloadsPanel } from './workloads-panel';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

const TABS = ['overview', 'workloads', 'ports', 'preflight', 'config'] as const;
type TabKey = (typeof TABS)[number];

/** « stable », « +6 pt », « −4 pt » : le sens dans lequel ça va sur 24 h. */
function trendOf(summary: MetricSummary | undefined, t: Translate<typeof messages.fr>): string {
  const trend = summary?.trend ?? null;
  if (trend === null) return '';
  if (Math.abs(trend) < 3) return t('readout.stable');
  return t('readout.trend', { value: `${trend > 0 ? '+' : '−'}${Math.round(Math.abs(trend))}` });
}

function toneOf(value: number | null, limit: number): Tone {
  if (value === null) return 'idle';
  if (value >= limit) return 'danger';
  if (value >= limit * 0.8) return 'warn';
  return 'ok';
}

/**
 * La fiche d'une cible — le lieu du travail long, là où le drawer n'est qu'un
 * aperçu. Onglets : Vue d'ensemble (tout, dans l'ordre de lecture), puis un
 * onglet par bloc pour qui cherche une seule chose.
 */
export default async function TargetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const auth = await requirePagePermission(`/targets/${parsed.data.id}`, 'target:read');
  const target = await getTarget(parsed.data.id);
  if (!target) notFound();

  const tabParam = (await searchParams).tab;
  const tab: TabKey = TABS.includes(tabParam as TabKey) ? (tabParam as TabKey) : 'overview';
  const canDelete = auth.can('target:delete');

  const [ports, { settings }, t, histories, samples, counts] = await Promise.all([
    getTargetPortReport(target.id),
    getAppSettings(),
    getT(messages),
    targetHistories([target.id], 24, 24),
    listTargetSamples(target.id, 1),
    canDelete ? countDeploymentsOnTarget(target.id) : Promise.resolve(null),
  ]);
  const format = formatSettingsOf(settings);
  const labels = sortedLabelEntries(target.labels);
  const history = histories.get(target.id);
  const latest = samples[0]?.reachable ? samples[0] : null;
  const report = target.preflightReport;

  const deleteBlockedReason = !counts
    ? null
    : counts.live > 0
      ? t('error.liveDeployments', { count: counts.live })
      : counts.history > 0
        ? t('error.pastDeployments', { count: counts.history })
        : null;

  const date = (value: Date | null) =>
    value === null
      ? t('preflight.never')
      : formatDateTimeWith(value.toISOString(), format, { dateStyle: 'short', timeStyle: 'short' });

  const gib = (kb: number | bigint | null) => (kb === null ? 0 : Number(kb) / 1024 / 1024);
  const uptime = latest?.uptimeSeconds ? Number(latest.uptimeSeconds) : null;
  const passed = report?.checks.filter((check) => check.status === 'success').length ?? 0;
  const totalMs = report?.checks.reduce((sum, check) => sum + check.durationMs, 0) ?? 0;

  const show = (section: TabKey) => tab === 'overview' || tab === section;

  return (
    <>
      <Crumb label={target.name} />
      <PageHeader
        title={target.name}
        status={<State tone={STATUS_TONE[target.status]}>{t(`status.${target.status}`)}</State>}
        actions={
          <TargetActions
            target={{ id: target.id, name: target.name, host: target.host }}
            canRunPreflight={auth.can('target:update')}
            canEdit={auth.can('target:update')}
            canDelete={canDelete}
            deleteBlockedReason={deleteBlockedReason}
          />
        }
      >
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-text-2">
          <span className="mono text-[13px]">
            {target.sshUser}@{target.host}:{target.port}
          </span>
          {target.description ? (
            <>
              <span className="text-text-3">·</span>
              <span className="t-sm">{target.description}</span>
            </>
          ) : null}
        </p>
        {labels.length > 0 ? (
          /*
            Chaque étiquette renvoie vers la liste filtrée sur elle : « qui
            d'autre porte env=prod ? » est la question qui suit immédiatement.
          */
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {labels.map(([key, value]) => (
              <Link
                key={`${key}=${value}`}
                href={`/targets?label=${encodeURIComponent(`${key}=${value}`)}`}
                title={t('label.link.title', { pair: `${key}=${value}` })}
              >
                <TargetLabelChip labelKey={key} value={value} />
              </Link>
            ))}
          </div>
        ) : null}
      </PageHeader>

      <Tabs label={t('detail.tabs')} asNav>
        {TABS.map((key) => (
          <TabLink
            key={key}
            href={key === 'overview' ? `/targets/${target.id}` : `/targets/${target.id}?tab=${key}`}
            selected={tab === key}
            scroll={false}
            count={key === 'ports' && ports ? `${ports.used}/${ports.capacity}` : undefined}
          >
            {t(`detail.tab.${key}`)}
          </TabLink>
        ))}
      </Tabs>

      {tab === 'overview' ? (
        <ReadoutBar>
          <Readout
            label={t('readout.load')}
            aside={trendOf(history?.summary.load, t)}
            value={latest?.loadPercent == null ? '—' : Math.round(latest.loadPercent)}
            unit={latest?.loadPercent == null ? undefined : '%'}
            tone={toneOf(latest?.loadPercent ?? null, HOST_METRIC_CATALOG.load.defaultLimitPercent)}
            hint={
              latest?.loadPercent != null && latest.cores
                ? t('readout.load.hint', { count: latest.cores, value: Math.round(latest.loadPercent) })
                : t('readout.none')
            }
          />
          <Readout
            label={t('readout.memory')}
            aside={trendOf(history?.summary.memory, t)}
            value={latest?.memoryPercent == null ? '—' : Math.round(latest.memoryPercent)}
            unit={latest?.memoryPercent == null ? undefined : '%'}
            tone={toneOf(latest?.memoryPercent ?? null, HOST_METRIC_CATALOG.memory.defaultLimitPercent)}
            hint={
              latest?.memoryTotalKb
                ? t('readout.memory.hint', {
                    used: gib(latest.memoryUsedKb).toFixed(1).replace('.', ','),
                    total: gib(latest.memoryTotalKb).toFixed(1).replace('.', ','),
                  })
                : t('readout.none')
            }
          />
          <Readout
            label={t('readout.disk')}
            aside={trendOf(history?.summary.disk, t)}
            value={latest?.diskPercent == null ? '—' : Math.round(latest.diskPercent)}
            unit={latest?.diskPercent == null ? undefined : '%'}
            tone={toneOf(latest?.diskPercent ?? null, HOST_METRIC_CATALOG.disk.defaultLimitPercent)}
            hint={
              latest?.diskSizeKb
                ? t('readout.disk.hint', {
                    free: Math.round(gib(latest.diskSizeKb) - gib(latest.diskUsedKb)),
                    path: latest.diskPath ?? '/',
                  })
                : t('readout.none')
            }
          />
          <Readout
            label={t('readout.uptime')}
            value={
              uptime === null
                ? '—'
                : uptime >= 86_400
                  ? t('readout.uptime.days', {
                      days: Math.floor(uptime / 86_400),
                      hours: Math.floor((uptime % 86_400) / 3600),
                    })
                  : t('readout.uptime.hours', {
                      hours: Math.floor(uptime / 3600),
                      minutes: Math.floor((uptime % 3600) / 60),
                    })
            }
            tone={uptime === null ? 'idle' : 'ok'}
            hint={
              report?.os.prettyName
                ? `${report.os.prettyName}${report.os.uname ? ` · ${report.os.uname.split(' ')[1] ?? ''}` : ''}`
                : t('readout.none')
            }
          />
        </ReadoutBar>
      ) : null}

      {tab === 'overview' || tab === 'ports' ? (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          {tab === 'overview' ? (
            <section className="card">
              <div className="card-h">
                <h2>{t('detail.runtimes.title')}</h2>
              </div>
              <div className="card-b flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <RuntimePill
                    name="Docker"
                    version={target.runtimesAvailable.docker.version}
                    available={target.runtimesAvailable.docker.available}
                  />
                  {target.runtimesAvailable.docker.composeVersion ? (
                    <RuntimePill
                      name="Docker Compose"
                      version={target.runtimesAvailable.docker.composeVersion}
                      available
                    />
                  ) : null}
                  <RuntimePill
                    name="K3s"
                    version={target.runtimesAvailable.k3s.version}
                    available={target.runtimesAvailable.k3s.available && target.runtimesAvailable.k3s.clusterReady}
                  />
                </div>
                <p className="t-sm text-text-2">
                  {report
                    ? t('detail.runtimes.summary', {
                        date: date(target.lastPreflightAt),
                        timezone: format.timezone,
                        ok: passed,
                        total: report.checks.length,
                        seconds: (totalMs / 1000).toFixed(1).replace('.', ','),
                      })
                    : t('detail.runtimes.never')}
                </p>
              </div>
            </section>
          ) : null}
          {ports ? (
            <div className={tab === 'ports' ? 'lg:col-span-2' : undefined}>
              <PortsPanel report={ports} firewall={report?.firewall ?? null} format={format} />
            </div>
          ) : null}
        </div>
      ) : null}

      {show('workloads') && auth.can('workload:read') ? (
        <WorkloadsPanel targetId={target.id} canManage={auth.can('workload:manage')} />
      ) : null}

      {show('preflight') ? <ReportDetails report={report} /> : null}

      {tab === 'config' ? (
        <section className="card max-w-3xl">
          <div className="card-h">
            <h2>{t('detail.config.title')}</h2>
          </div>
          <div className="card-b">
            <KeyValue
              items={[
                { term: t('field.name'), value: <span className="mono">{target.name}</span> },
                {
                  term: t('drawer.address'),
                  value: (
                    <span className="mono">
                      {target.sshUser}@{target.host}:{target.port}
                    </span>
                  ),
                },
                {
                  term: t('field.authMethod'),
                  value: target.authMethod === 'key' ? t('value.auth.key') : t('value.auth.password'),
                },
                {
                  term: t('field.sudoMethod'),
                  value: target.sudoMethod === 'nopasswd' ? t('value.sudo.nopasswd') : t('value.sudo.password'),
                },
                { term: t('field.credential'), value: t('value.credential') },
                {
                  term: t('field.portRangeShort'),
                  value: (
                    <span className="mono">
                      {target.portRangeStart}–{target.portRangeEnd}
                    </span>
                  ),
                },
                { term: t('field.description'), value: target.description ?? '—' },
              ]}
            />
          </div>
        </section>
      ) : null}
    </>
  );
}
