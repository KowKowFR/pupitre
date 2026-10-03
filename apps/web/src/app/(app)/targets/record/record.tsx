import 'server-only';
import type { ReactNode } from 'react';
import type { Translate } from '@pupitre/core';
import {
  getTargetPortReport,
  HOST_METRIC_CATALOG,
  listTargetSamples,
  targetHistories,
  type MetricSummary,
  type PublicTarget,
} from '@pupitre/db';
import { Readout, ReadoutBar, type Tone } from '@/components/instrument';
import { ProxyPanel } from '@/components/proxy/proxy-panel';
import { KeyValue } from '@/components/ui/data';
import { getT } from '@/i18n/server';
import { targets as messages } from '@/i18n/messages/targets';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import type { AuthContext } from '@/lib/rbac';
import { HostKeyAlert } from './host-key-alert';
import { PortsPanel } from './ports-panel';
import { ReportDetails } from './report-details';
import { WorkloadsPanel } from './workloads-panel';

export type TargetRecordTab = 'workloads' | 'proxy' | 'ports' | 'preflight' | 'config';

export type TargetRecord = {
  /** Le nom de la cible : c'est la clé du tiroir. */
  key: string;
  /** Ce qui ouvre l'aperçu : empreinte SSH à trancher, relevés de la machine. */
  overview: ReactNode;
  tabs: Partial<Record<TargetRecordTab, ReactNode>>;
  counts: Partial<Record<TargetRecordTab, string>>;
};

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
 * La fiche d'une cible, rendue au serveur pour son tiroir : les relevés de la
 * machine en tête de l'aperçu, puis ses charges, son reverse proxy, ses ports,
 * le détail de son preflight et sa configuration. Ce que la ligne porte déjà —
 * état, connexion, runtimes, charge sur 24 h, applications — s'affiche sans
 * attendre ce rendu.
 */
export async function targetRecord(
  target: PublicTarget,
  auth: AuthContext,
  format: FormatSettings,
): Promise<TargetRecord> {
  const [ports, t, histories, samples] = await Promise.all([
    getTargetPortReport(target.id),
    getT(messages),
    targetHistories([target.id], 24, 24),
    listTargetSamples(target.id, 1),
  ]);
  const history = histories.get(target.id);
  const latest = samples[0]?.reachable ? samples[0] : null;
  const report = target.preflightReport;

  const date = (value: Date | null) =>
    value === null
      ? t('preflight.never')
      : formatDateTimeWith(value.toISOString(), format, {
          dateStyle: 'short',
          timeStyle: 'short',
          timeZone: format.timezone,
        });
  const gib = (kb: number | bigint | null) => (kb === null ? 0 : Number(kb) / 1024 / 1024);
  const uptime = latest?.uptimeSeconds ? Number(latest.uptimeSeconds) : null;
  const passed = report?.checks.filter((check) => check.status === 'success').length ?? 0;
  const totalMs = report?.checks.reduce((sum, check) => sum + check.durationMs, 0) ?? 0;

  const overview = (
    <>
      {target.hostKeyPending ? (
        <HostKeyAlert
          target={{ id: target.id, name: target.name }}
          expected={target.hostKeyFingerprint}
          presented={target.hostKeyPending}
          since={date(target.hostKeyPendingAt)}
          canDecide={auth.can('target:update')}
        />
      ) : null}
      <ReadoutBar>
        <Readout
          label={t('readout.load')}
          aside={trendOf(history?.summary.load, t)}
          value={latest?.loadPercent == null ? '—' : Math.round(latest.loadPercent)}
          unit={latest?.loadPercent == null ? undefined : '%'}
          tone={toneOf(latest?.loadPercent ?? null, HOST_METRIC_CATALOG.load.defaultLimitPercent)}
          hint={
            latest?.loadPercent != null && latest.cores
              ? t('readout.load.hint', {
                  count: latest.cores,
                  value: Math.round(latest.loadPercent),
                })
              : t('readout.none')
          }
        />
        <Readout
          label={t('readout.memory')}
          aside={trendOf(history?.summary.memory, t)}
          value={latest?.memoryPercent == null ? '—' : Math.round(latest.memoryPercent)}
          unit={latest?.memoryPercent == null ? undefined : '%'}
          tone={toneOf(
            latest?.memoryPercent ?? null,
            HOST_METRIC_CATALOG.memory.defaultLimitPercent,
          )}
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
    </>
  );

  return {
    key: target.name,
    overview,
    counts: ports ? { ports: `${ports.used}/${ports.capacity}` } : {},
    tabs: {
      ...(auth.can('workload:read')
        ? {
            workloads: (
              <WorkloadsPanel
                targetId={target.id}
                canManage={auth.can('workload:manage')}
                canExec={auth.can('workload:exec')}
              />
            ),
          }
        : {}),
      proxy: (
        <ProxyPanel
          targetId={target.id}
          targetName={target.name}
          canManage={auth.can('target:update')}
          format={format}
          defaultEmail={auth.email}
        />
      ),
      ports: ports ? (
        <PortsPanel report={ports} firewall={report?.firewall ?? null} format={format} />
      ) : null,
      preflight: (
        <>
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
          <ReportDetails report={report} />
        </>
      ),
      config: (
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
              value:
                target.sudoMethod === 'nopasswd'
                  ? t('value.sudo.nopasswd')
                  : t('value.sudo.password'),
            },
            { term: t('field.credential'), value: t('value.credential') },
            {
              term: t('field.hostKey'),
              value: target.hostKeyFingerprint ? (
                <span className="flex flex-col gap-0.5">
                  <span className="mono break-all">{target.hostKeyFingerprint}</span>
                  <span className="t-cap text-text-3">
                    {t('hostKey.recorded', { date: date(target.hostKeyRecordedAt) })}
                  </span>
                </span>
              ) : (
                <span className="text-text-3">{t('hostKey.none')}</span>
              ),
            },
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
      ),
    },
  };
}
