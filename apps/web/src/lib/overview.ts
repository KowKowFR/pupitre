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
import type { AuthContext } from '@/lib/rbac';

/**
 * Les lectures de la vue d'ensemble, partagées avec la coquille.
 *
 * Le rail affiche ce que la vue d'ensemble calcule — le nombre de points qui
 * demandent une intervention, un déploiement en vol, les incidents ouverts.
 * Les deux lisent donc les mêmes sources, et `cache()` garantit qu'une même
 * requête HTTP ne les lit qu'une fois : sur `/`, le layout et la page
 * partagent chaque lecture.
 */

/** Profondeur de la chronique des déploiements, en jours. */
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

/** Les points d'attention d'une session, lus uniquement dans ce qu'elle a le droit de voir. */
export const attentionFor = cache(async (auth: AuthContext): Promise<AttentionItem[]> => {
  const t = await getT(dashboard);
  const canReadTargets = auth.can('target:read');
  const canReadDeployments = auth.can('deployment:read');
  const [targets, running, monitors, recent, chronicle, posture] = await Promise.all([
    canReadTargets ? loadTargets() : Promise.resolve([] as PublicTarget[]),
    canReadDeployments ? loadSupervisedApps() : Promise.resolve([]),
    auth.can('monitor:read') ? loadMonitors() : Promise.resolve([]),
    canReadDeployments ? loadRecentDeployments() : Promise.resolve(null),
    canReadDeployments ? loadDeploymentPulse() : Promise.resolve(null),
    auth.can('scan:read') ? loadScanPosture() : Promise.resolve(null),
  ]);
  return collectAttention({
    targets,
    running,
    monitors,
    recent: recent?.items ?? [],
    chronicle,
    posture,
    t,
  });
});

/**
 * Rassemble les anomalies des sources qui peuvent en produire.
 *
 * Une même panne ne doit apparaître qu'une fois : une cible injoignable rend
 * ses applications injoignables, et lister les deux ferait croire à deux
 * incidents. Les cibles muettes sont donc relevées d'abord, et leurs
 * applications écartées ensuite.
 */
export function collectAttention({
  targets,
  running,
  monitors,
  recent,
  chronicle,
  posture,
  t,
}: {
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
    items.push({
      subject: target.name,
      detail:
        target.status === 'unreachable'
          ? t('attention.target.unreachable', { host: target.host })
          : t('attention.target.degraded', { host: target.host }),
      severity: target.status === 'unreachable' ? 'danger' : 'warn',
      href: `/targets?target=${target.id}`,
      action: t('attention.action.diagnose'),
    });
  }

  for (const app of running) {
    if (mute.has(app.targetName)) continue;

    if (app.healthStatus === 'unreachable' || app.healthStatus === 'unhealthy') {
      items.push({
        subject: `${app.applicationSlug}@${app.targetName}`,
        detail:
          app.healthStatus === 'unreachable'
            ? t('attention.app.unreachable')
            : t('attention.app.unhealthy'),
        severity: app.healthStatus === 'unreachable' ? 'danger' : 'warn',
        href: `/apps/${app.id}`,
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
        href: `/deployments/${app.lastFailedUpdate.deploymentId}`,
        action: t('attention.action.trace'),
      });
    }
  }

  for (const monitor of monitors) {
    if (!monitor.enabled) continue;
    if (monitor.status !== 'unreachable' && monitor.status !== 'unhealthy') continue;
    items.push({
      subject: monitor.name,
      detail:
        monitor.status === 'unreachable'
          ? t('attention.monitor.unreachable')
          : t('attention.monitor.unhealthy'),
      severity: monitor.status === 'unreachable' ? 'danger' : 'warn',
      href: `/monitors?monitor=${monitor.id}`,
      action: t('attention.action.monitor'),
    });
  }

  // Un déploiement raté d'une application qui tourne encore est déjà relevé
  // ci-dessus, avec plus de contexte. On ne garde ici que les échecs orphelins.
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
      href: `/deployments/${item.id}`,
      action: t('attention.action.trace'),
    });
  }

  /*
    Un repli n'est pas un échec — le garde-fou a fait son travail — mais c'est
    une version qu'on a voulu livrer et qui n'a pas tenu. Elle mérite d'être vue
    une fois, pas de disparaître dans un compteur. On ne relève que les replis
    de la fenêtre courte : celui d'il y a six jours a déjà été traité ou ne le
    sera jamais, et l'écran des anomalies n'est pas un journal.
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
        href: `/deployments/${event.id}`,
        action: t('attention.action.trace'),
      });
    }
  }

  /*
    Le seul endroit du produit où un chiffre rassurant en recouvre un qui ne
    l'est pas : une analyse conclut « conforme » parce que le seuil de blocage
    est réglé sur « aucun », pendant qu'elle rapporte des failles critiques.
    Rien dans l'écran ne le disait — on lisait « scan : conforme » et on passait.
  */
  if (posture && posture.passedWithSevere > 0 && posture.bySeverity.critical > 0) {
    items.push({
      subject: t('attention.scans.subject'),
      detail:
        `${t('attention.scans.lead', { count: posture.passedWithSevere })} ` +
        `${t('attention.scans.critical', { count: posture.bySeverity.critical })} ` +
        t('attention.scans.tail', { high: posture.bySeverity.high }),
      severity: 'warn',
      href: '/admin/settings',
      action: t('attention.action.threshold'),
    });
  }

  return items;
}
