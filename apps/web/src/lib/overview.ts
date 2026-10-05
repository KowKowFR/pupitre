import 'server-only';
import { cache } from 'react';
import type { Translate } from '@pupitre/core';
import {
  deploymentPulse,
  deploymentQuerySchema,
  listApplications,
  listDeployments,
  listMonitors,
  listSupervisedApps,
  listTargets,
  scanPosture,
  type DeploymentPulse,
  type DeploymentSummary,
  type PublicTarget,
  type ScanPosture,
} from '@pupitre/db';
import { getT } from '@/i18n/server';
import { dashboard } from '@/i18n/messages/dashboard';
import { visibleCoverage } from '@/lib/maintenance';
import type { AuthContext } from '@/lib/rbac';

/**
 * The overview's reads, shared with the shell.
 *
 * The rail shows what the overview computes — the number of points that require
 * an intervention, a deployment in flight, the open incidents. Both therefore
 * read the same sources, and `cache()` guarantees that one HTTP request only reads
 * them once: on `/`, the layout and the page share each read.
 */

/** The depth of the deployments chronicle, in days. */
export const CHRONICLE_DAYS = 7;

export const loadTargets = cache(() => listTargets());
export const loadApplications = cache(() => listApplications());
export const loadSupervisedApps = cache(() => listSupervisedApps());
export const loadMonitors = cache(() => listMonitors());
export const loadRecentDeployments = cache(() =>
  listDeployments(deploymentQuerySchema.parse({ pageSize: '6' })),
);
export const loadDeploymentPulse = cache(() => deploymentPulse(CHRONICLE_DAYS));
export const loadScanPosture = cache(() => scanPosture(CHRONICLE_DAYS));

export type AttentionSeverity = 'danger' | 'warn';

export type AttentionItem = {
  subject: string;
  detail: string;
  severity: AttentionSeverity;
  href: string;
  action: string;
};

type T = Translate<typeof dashboard.fr>;

/** A session's attention points, read only in what it is allowed to see. */
export const attentionFor = cache(async (auth: AuthContext): Promise<AttentionItem[]> => {
  const t = await getT(dashboard);
  const canReadTargets = auth.can('target:read');
  const canReadDeployments = auth.can('deployment:read');
  const [targets, running, monitors, recent, chronicle, posture, coverage] = await Promise.all([
    canReadTargets ? loadTargets() : Promise.resolve([] as PublicTarget[]),
    canReadDeployments ? loadSupervisedApps() : Promise.resolve([]),
    auth.can('monitor:read') ? loadMonitors() : Promise.resolve([]),
    canReadDeployments ? loadRecentDeployments() : Promise.resolve(null),
    canReadDeployments ? loadDeploymentPulse() : Promise.resolve(null),
    auth.can('scan:read') ? loadScanPosture() : Promise.resolve(null),
    visibleCoverage(auth),
  ]);
  return collectAttention({
    targets,
    running,
    monitors,
    recent: recent?.items ?? [],
    chronicle,
    posture,
    maintenance: {
      targets: new Set(coverage.targets.keys()),
      monitors: new Set(coverage.monitors.keys()),
    },
    t,
  });
});

/** What is under maintenance: its points stay listed, marked and without a red alarm. */
export type MaintenanceMarks = { targets: ReadonlySet<string>; monitors: ReadonlySet<string> };

/**
 * Gathers the anomalies of the sources that can produce some.
 *
 * The same outage must only appear once: an unreachable target makes its
 * applications unreachable, and listing both would suggest two incidents. The
 * silent targets are therefore noted first, and their applications set aside
 * next.
 */
export function collectAttention({
  targets,
  running,
  monitors,
  recent,
  chronicle,
  posture,
  maintenance,
  t,
}: {
  /**
   * The targets and probes under maintenance. An outage there is often intended:
   * the point stays — one must see it come back —, but as a warning, with the
   * mention, and not in red.
   */
  maintenance?: MaintenanceMarks;
  targets: readonly PublicTarget[];
  running: Awaited<ReturnType<typeof listSupervisedApps>>;
  monitors: Awaited<ReturnType<typeof listMonitors>>;
  recent: readonly DeploymentSummary[];
  chronicle: DeploymentPulse | null;
  posture: ScanPosture | null;
  t: T;
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  const mute = new Set<string>();
  for (const target of targets) {
    if (target.status === 'ok' || target.status === 'unknown') continue;
    mute.add(target.name);
    const inMaintenance = maintenance?.targets.has(target.id) ?? false;
    items.push({
      subject: target.name,
      detail:
        (target.status === 'unreachable'
          ? t('attention.target.unreachable', { host: target.host })
          : t('attention.target.degraded', { host: target.host })) +
        (inMaintenance ? t('attention.maintenance') : ''),
      severity: target.status === 'unreachable' && !inMaintenance ? 'danger' : 'warn',
      href: `/targets?target=${target.id}`,
      action: t('attention.action.diagnose'),
    });
  }

  for (const app of running) {
    if (mute.has(app.targetName)) continue;

    if (app.healthStatus === 'unreachable' || app.healthStatus === 'unhealthy') {
      const inMaintenance = maintenance?.targets.has(app.targetId) ?? false;
      items.push({
        subject: `${app.applicationSlug}@${app.targetName}`,
        detail:
          (app.healthStatus === 'unreachable'
            ? t('attention.app.unreachable')
            : t('attention.app.unhealthy')) + (inMaintenance ? t('attention.maintenance') : ''),
        severity: app.healthStatus === 'unreachable' && !inMaintenance ? 'danger' : 'warn',
        href: `/apps?app=${app.id}`,
        action: t('attention.action.logs'),
      });
      continue;
    }

    if (app.lastFailedUpdate) {
      items.push({
        subject: `${app.applicationSlug}@${app.targetName}`,
        detail:
          t('attention.app.failed', {
            version: app.lastFailedUpdate.version,
            step: app.lastFailedUpdate.failedStep ?? t('attention.app.failed.unknownStep'),
          }) +
          (app.lastFailedUpdate.mayHaveReplacedServices
            ? t('attention.app.failed.replaced')
            : t('attention.app.failed.kept')),
        severity: 'warn',
        href: `/deployments?run=${app.lastFailedUpdate.deploymentId}`,
        action: t('attention.action.trace'),
      });
    }
  }

  for (const monitor of monitors) {
    if (!monitor.enabled) continue;
    if (monitor.status !== 'unreachable' && monitor.status !== 'unhealthy') continue;
    const inMaintenance = maintenance?.monitors.has(monitor.id) ?? false;
    items.push({
      subject: monitor.name,
      detail:
        (monitor.status === 'unreachable'
          ? t('attention.monitor.unreachable')
          : t('attention.monitor.unhealthy')) + (inMaintenance ? t('attention.maintenance') : ''),
      severity: monitor.status === 'unreachable' && !inMaintenance ? 'danger' : 'warn',
      href: `/monitors?monitor=${monitor.id}`,
      action: t('attention.action.monitor'),
    });
  }

  // A failed deployment of an application that still runs is already noted above,
  // with more context. We only keep the orphan failures here.
  const covered = new Set(running.map((app) => app.lastFailedUpdate?.deploymentId).filter(Boolean));
  for (const item of recent) {
    if (item.status !== 'failed' || covered.has(item.id)) continue;
    items.push({
      subject: `${item.applicationSlug} v${item.version}`,
      detail: t('attention.deployment.failed', {
        target: item.targetName,
        step: item.failedStep ? t('attention.deployment.atStep', { step: item.failedStep }) : '',
      }),
      severity: 'danger',
      href: `/deployments?run=${item.id}`,
      action: t('attention.action.trace'),
    });
  }

  /*
    A rollback is not a failure — the guardrail did its job — but it is a version
    one wanted to ship and that did not hold. It deserves to be seen once, not to
    disappear into a counter. We only note the rollbacks of the short window: the
    one from six days ago has already been dealt with or never will be, and the
    anomalies screen is not a log.
  */
  if (chronicle) {
    const recentEnough = Date.now() - 24 * 3600 * 1000;
    for (const event of chronicle.events) {
      if (event.status !== 'rolled_back') continue;
      if (Date.parse(event.at) < recentEnough) continue;
      items.push({
        subject: `${event.applicationSlug} v${event.version}`,
        detail: t('attention.deployment.rolledBack', {
          target: event.targetName,
          step: event.failedStep
            ? t('attention.deployment.refused', { step: event.failedStep })
            : '',
        }),
        severity: 'warn',
        href: `/deployments?run=${event.id}`,
        action: t('attention.action.trace'),
      });
    }
  }

  /*
    The only place in the product where a reassuring figure covers one that is
    not: an analysis concludes "compliant" because the blocking threshold is set
    to "none", while it reports critical vulnerabilities. Nothing in the screen
    said so — one read "scan: compliant" and moved on.
  */
  if (posture && posture.passedWithSevere > 0 && posture.bySeverity.critical > 0) {
    items.push({
      subject: t('attention.scans.subject'),
      detail:
        `${t('attention.scans.lead', { count: posture.passedWithSevere })} ` +
        `${t('attention.scans.critical', { count: posture.bySeverity.critical })} ` +
        (posture.fixableCritical > 0
          ? `${t('attention.scans.fixable', { count: posture.fixableCritical })} `
          : '') +
        t('attention.scans.tail', { high: posture.bySeverity.high }),
      severity: 'warn',
      href: '/admin/settings',
      action: t('attention.action.threshold'),
    });
  }

  return items;
}
