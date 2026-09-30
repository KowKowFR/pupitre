import type { PreflightReport } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { KeyValue } from '@/components/ui/data';
import { getT } from '@/i18n/server';
import { common } from '@/i18n/messages/common';
import { targets as messages } from '@/i18n/messages/targets';

function gib(kb: number, unit: string): string {
  return `${(kb / 1024 / 1024).toFixed(1)} ${unit}`;
}

/**
 * Ce que le dernier preflight a lu de la machine, et le détail de ses
 * contrôles. Chaque contrôle est indépendant : un échec n'invalide pas les
 * autres, et la table le montre ligne par ligne.
 */
export async function ReportDetails({ report }: { report: PreflightReport | null }) {
  const t = await getT(messages);
  const tc = await getT(common);

  if (!report) {
    return (
      <section className="card card-b">
        <h2 className="t-h">{t('report.title')}</h2>
        <p className="t-sm mt-1 text-text-2">{t('report.none')}</p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {report.error ? (
        <Alert variant="destructive" title={t('report.unreachable')}>
          <span className="mono">{report.error}</span>
        </Alert>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <section className="card">
          <div className="card-h">
            <h2>{t('report.machine')}</h2>
          </div>
          <div className="card-b">
            <KeyValue
              items={[
                { term: t('row.os'), value: report.os.prettyName ?? report.os.name ?? tc('none') },
                { term: t('row.kernel'), value: <span className="mono">{report.os.uname ?? tc('none')}</span> },
                {
                  term: t('row.latency'),
                  value: <span className="mono">{report.latencyMs === null ? tc('none') : `${report.latencyMs} ms`}</span>,
                },
                {
                  term: t('row.sudo'),
                  value: report.sudo.nopasswd
                    ? t('value.sudo.nopasswd')
                    : report.sudo.available
                      ? t('sudo.passwordRequired')
                      : t('sudo.unavailable'),
                },
                {
                  term: t('row.disk'),
                  value: report.disk
                    ? t('disk.value', {
                        available: gib(report.disk.availableKb, t('unit.gib')),
                        size: gib(report.disk.sizeKb, t('unit.gib')),
                        percent: report.disk.usePercent,
                      })
                    : tc('none'),
                },
                {
                  term: t('row.memory'),
                  value: report.memory
                    ? t('memory.value', { available: report.memory.availableMb, total: report.memory.totalMb })
                    : tc('none'),
                },
                {
                  term: t('row.tools'),
                  value: (
                    <span className="inline-flex flex-wrap justify-end gap-1">
                      {Object.entries(report.tools).map(([tool, present]) => (
                        <Badge key={tool} variant={present ? 'ok' : 'outline'} className="mono">
                          {tool}
                        </Badge>
                      ))}
                    </span>
                  ),
                },
                {
                  term: t('row.compose'),
                  value: <span className="mono">{report.runtimes.docker.composeVersion ?? tc('none')}</span>,
                },
                {
                  term: t('row.readyNodes'),
                  value:
                    report.runtimes.k3s.nodes === null
                      ? tc('none')
                      : `${report.runtimes.k3s.readyNodes ?? 0} / ${report.runtimes.k3s.nodes}`,
                },
              ]}
            />
          </div>
        </section>

        <section className="card overflow-hidden">
          <div className="card-h">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h2>{t('report.checks.title')}</h2>
              <span className="sub">{t('report.checks.description')}</span>
            </div>
          </div>
          <div className="tbl-wrap">
            <table className="tbl dense">
              <thead>
                <tr>
                  <th>{t('column.check')}</th>
                  <th>{tc('column.status')}</th>
                  <th>{tc('column.duration')}</th>
                  <th>{tc('column.detail')}</th>
                </tr>
              </thead>
              <tbody>
                {report.checks.map((check) => (
                  <tr key={check.key}>
                    <td className="font-medium">{check.label}</td>
                    <td>
                      <Badge
                        dot
                        variant={
                          check.status === 'success' ? 'ok' : check.status === 'failed' ? 'danger' : 'idle'
                        }
                      >
                        {t(`check.status.${check.status}`)}
                      </Badge>
                    </td>
                    <td className="mono text-text-3">{check.durationMs} ms</td>
                    <td className="text-text-2">{check.error ?? check.detail ?? tc('none')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
