import Link from 'next/link';
import type { DeploymentStatus, FirewallInfo, Translate } from '@pupitre/core';
import type { TargetPortReport } from '@pupitre/db';
import { Badge } from '@/components/ui/badge';
import { getT } from '@/i18n/server';
import { targets as messages } from '@/i18n/messages/targets';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import { withSlot } from '@/lib/rich';
import { DeploymentStatusBadge } from '../../deployments/status-badge';

/**
 * Les ports alloués d'une cible : la plage, sa jauge d'occupation, l'état du
 * pare-feu, puis un port par ligne. La jauge verdit, ambre à 70 %, rougit à
 * 90 % — une plage presque pleine bloque le prochain déploiement.
 */
export async function PortsPanel({
  report,
  firewall,
  format,
}: {
  report: TargetPortReport;
  firewall: FirewallInfo | null;
  format: FormatSettings;
}) {
  const t = await getT(messages);
  const ratio = report.capacity === 0 ? 0 : report.used / report.capacity;
  const percent = Math.round(ratio * 100);
  const tone = ratio >= 0.9 ? 'var(--danger)' : ratio >= 0.7 ? 'var(--warn)' : 'var(--ok)';

  return (
    <section className="card overflow-hidden">
      <div className="card-h">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2>{t('ports.title')}</h2>
          <span className="sub">
            {t('ports.sub', {
              min: report.range.min,
              max: report.range.max,
              free: t('ports.free', { count: report.free }),
            })}
          </span>
        </div>
        <FirewallBadge firewall={firewall} t={t} />
      </div>
      <div className="card-b flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <div
            className="meter"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={report.capacity}
            aria-valuenow={report.used}
            aria-label={t('ports.title')}
          >
            <span style={{ width: `${Math.min(100, Math.max(percent, report.used > 0 ? 2 : 0))}%`, background: tone }} />
          </div>
          <div className="axis">
            <span className="mono">{report.range.min}</span>
            <span>{t('ports.axis', { count: report.used, capacity: report.capacity, percent })}</span>
            <span className="mono">{report.range.max}</span>
          </div>
        </div>
        <p className="t-cap text-text-3">
          {firewall?.active ? `${t('firewall.rules', { count: firewall.managedRules.length })} ` : ''}
          {report.freeSample.length > 0 ? (
            withSlot(
              (slot) => t('ports.freeSample', { list: slot }),
              <span className="mono">
                {report.freeSample.slice(0, 4).join(', ')}
                {report.free > 4 ? '…' : ''}
              </span>,
            )
          ) : (
            <span className="text-danger-text">{t('ports.exhausted')}</span>
          )}
        </p>
      </div>
      {report.allocations.length === 0 ? (
        <p className="t-sm border-t border-border-subtle px-4 py-4 text-text-3">{t('ports.empty')}</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl dense">
            <thead>
              <tr>
                <th>{t('ports.column.port')}</th>
                <th>{t('ports.column.application')}</th>
                <th>{t('ports.column.lastDeployment')}</th>
                <th>{t('ports.column.reservedAt')}</th>
              </tr>
            </thead>
            <tbody>
              {report.allocations.map((allocation) => {
                const outOfRange = allocation.port < report.range.min || allocation.port > report.range.max;
                return (
                  <tr key={allocation.port}>
                    <td className="mono">
                      {allocation.port}
                      {outOfRange ? (
                        <Badge variant="warn" className="ml-2">
                          {t('ports.outOfRange')}
                        </Badge>
                      ) : null}
                    </td>
                    <td>
                      <Link href={`/applications?app=${allocation.applicationId}`} className="mono text-text hover:underline">
                        {allocation.applicationSlug}
                      </Link>
                    </td>
                    <td>
                      {allocation.deploymentId ? (
                        <Link
                          href={`/deployments/${allocation.deploymentId}`}
                          className="inline-flex items-center gap-2"
                        >
                          {allocation.deploymentStatus ? (
                            <DeploymentStatusBadge status={allocation.deploymentStatus as DeploymentStatus} />
                          ) : null}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="mono text-text-3">
                      {formatDateTimeWith(allocation.reservedAt.toISOString(), format, {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FirewallBadge({
  firewall,
  t,
}: {
  firewall: FirewallInfo | null;
  t: Translate<typeof messages.fr>;
}) {
  if (!firewall) return <span className="t-cap text-text-3">{t('firewall.unknown')}</span>;
  if (!firewall.installed) {
    return (
      <Badge variant="outline" title={t('firewall.absent.text')}>
        {t('firewall.absent.badge')}
      </Badge>
    );
  }
  if (!firewall.active) {
    return (
      <Badge variant="warn" dot title={t('firewall.inactive.text')}>
        {t('firewall.inactive.badge')}
      </Badge>
    );
  }
  return (
    <Badge variant="ok" dot>
      {t('firewall.active.badge')}
    </Badge>
  );
}
