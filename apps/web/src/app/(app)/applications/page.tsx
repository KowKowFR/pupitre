import { describeProxy, hasBackupData, proxyCapabilities, usableRuntimes } from '@pupitre/core';
import {
  getActiveBackupDestination,
  listApplications,
  listBackupPolicyApplicationIds,
  listImageUpdateSummaries,
  listRoutes,
  listServingProxies,
  listSupervisedApps,
  listTargets,
} from '@pupitre/db';
import { LiveRefresh } from '@/components/realtime/live-refresh';
import { getT } from '@/i18n/server';
import { common } from '@/i18n/messages/common';
import { newApplicationAi } from '@/lib/new-application';
import { requirePagePermission } from '@/lib/page-auth';
import { relativeTime } from '@/lib/relative-time';
import { ApplicationsView, type ApplicationRow, type DeployTarget } from './applications-view';
import { ingressOf, serviceRows } from './rows';

export const dynamic = 'force-dynamic';

/**
 * Le catalogue des applications, avec leur aperçu : ce qui va tourner, où
 * elles sont en service, et un déploiement rapide sur une cible prête.
 */
export default async function ApplicationsPage() {
  const auth = await requirePagePermission('/applications', 'application:read');
  const canDeploy = auth.can('deployment:create');
  const [
    applications,
    targets,
    running,
    tc,
    imageSummaries,
    policyIds,
    backupDestination,
    proxies,
    routes,
  ] = await Promise.all([
    listApplications(),
    canDeploy ? listTargets() : Promise.resolve([]),
    auth.can('deployment:read') ? listSupervisedApps() : Promise.resolve(null),
    getT(common),
    listImageUpdateSummaries(),
    listBackupPolicyApplicationIds(),
    getActiveBackupDestination(),
    canDeploy ? listServingProxies() : Promise.resolve(new Map()),
    canDeploy ? listRoutes({}) : Promise.resolve([]),
  ]);

  const items: ApplicationRow[] = applications.map((application) => ({
    id: application.id,
    slug: application.slug,
    name: application.name,
    description: application.description,
    version: application.appSpec.version,
    services: serviceRows(application.appSpec),
    ingress: ingressOf(application.appSpec),
    live:
      running === null
        ? null
        : running
            .filter((app) => app.applicationId === application.id)
            .map((app) => ({
              id: app.id,
              targetName: app.targetName,
              health: app.healthStatus,
              ago: relativeTime(app.finishedAt ?? app.createdAt, tc),
            })),
    backup: {
      configured: policyIds.has(application.id),
      hasData: hasBackupData(application.appSpec),
    },
    imageUpdates: (() => {
      const summary = imageSummaries.find((entry) => entry.applicationId === application.id);
      return summary ? { outdated: summary.outdated, newerTags: summary.newerTags } : null;
    })(),
    domains: routes
      .filter((route) => route.applicationId === application.id)
      .reduce<ApplicationRow['domains']>((byTarget, route) => {
        (byTarget[route.targetId] ??= []).push({ hostname: route.hostname, tls: route.tls });
        return byTarget;
      }, {}),
  }));

  // Une cible n'est déployable que si son preflight a montré un runtime : on
  // ne propose que ceux-là, comme sur « Nouvelle application ».
  const deployTargets: DeployTarget[] = targets
    .filter((target) => usableRuntimes(target.runtimesAvailable).length > 0)
    .map((target) => ({
      id: target.id,
      name: target.name,
      host: target.host,
      runtimes: usableRuntimes(target.runtimesAvailable),
      dockerVersion: target.runtimesAvailable.docker.version,
      k3sVersion: target.runtimesAvailable.k3s.version,
      healthy: target.status === 'ok',
      proxy: (() => {
        const serving = proxies.get(target.id);
        if (!serving || serving.proxy.status === 'installing') return null;
        const { proxy, link } = serving;
        // Le proxy d'une autre machine, ou un proxy distant : on dit lequel.
        const via = link
          ? (targets.find((candidate) => candidate.id === proxy.hostTargetId)?.name ?? proxy.name)
          : null;
        return {
          description: describeProxy(proxy.kind, proxy.config),
          capabilities: proxyCapabilities(proxy.kind, proxy.config),
          via: via ?? null,
        };
      })(),
    }))
    // Les cibles opérationnelles d'abord : c'est parmi elles que se choisit la
    // cible proposée par défaut.
    .sort((a, b) => Number(b.healthy) - Number(a.healthy));

  return (
    <>
      <LiveRefresh topics={['applications', 'deployments']} />
      <ApplicationsView
        items={items}
        targets={deployTargets}
        canCreate={auth.can('application:create')}
        canDeploy={canDeploy}
        canDelete={auth.can('application:delete')}
        ai={auth.can('application:create') ? await newApplicationAi() : null}
        backupOptions={
          auth.can('backup:manage') ? { hasDestination: backupDestination !== null } : null
        }
      />
    </>
  );
}
