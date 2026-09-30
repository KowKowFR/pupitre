import { usableRuntimes } from '@pupitre/core';
import { listApplications, listSupervisedApps, listTargets } from '@pupitre/db';
import { getT } from '@/i18n/server';
import { common } from '@/i18n/messages/common';
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
  const [applications, targets, running, tc] = await Promise.all([
    listApplications(),
    canDeploy ? listTargets() : Promise.resolve([]),
    auth.can('deployment:read') ? listSupervisedApps() : Promise.resolve(null),
    getT(common),
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
    }))
    // Les cibles opérationnelles d'abord : c'est parmi elles que se choisit la
    // cible proposée par défaut.
    .sort((a, b) => Number(b.healthy) - Number(a.healthy));

  return (
    <ApplicationsView
      items={items}
      targets={deployTargets}
      canCreate={auth.can('application:create')}
      canDeploy={canDeploy}
      canDelete={auth.can('application:delete')}
    />
  );
}
