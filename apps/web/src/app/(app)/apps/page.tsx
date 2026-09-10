import { listSupervisedApps } from '@tp/db';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { requirePagePermission } from '@/lib/page-auth';
import { AppsTable, type SupervisedRow } from './apps-table';

export const dynamic = 'force-dynamic';

export default async function AppsPage() {
  const auth = await requirePagePermission('/apps', 'deployment:read');
  const apps = await listSupervisedApps();

  const items: SupervisedRow[] = apps.map((app) => ({
    id: app.id,
    applicationSlug: app.applicationSlug,
    targetName: app.targetName,
    targetHost: app.targetHost,
    runtime: app.runtime,
    version: app.version,
    status: app.status,
    healthStatus: app.healthStatus,
    lastHealthAt: app.lastHealthAt?.toISOString() ?? null,
    url: app.url,
    publishedPort: app.publishedPort,
    services: app.services,
    startedAt: app.startedAt?.toISOString() ?? null,
    lastFailedUpdate: app.lastFailedUpdate
      ? {
          deploymentId: app.lastFailedUpdate.deploymentId,
          version: app.lastFailedUpdate.version,
          failedStep: app.lastFailedUpdate.failedStep,
          mayHaveReplacedServices: app.lastFailedUpdate.mayHaveReplacedServices,
        }
      : null,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Supervision"
        title="Applications en marche"
        description="Ce qui tourne en ce moment sur vos cibles — une ligne par application et par machine. Une application dont la dernière mise à jour a échoué reste ici : elle tourne toujours, dans sa version précédente. L'historique des déploiements est ailleurs."
      />

      {items.length === 0 ? (
        <EmptyState
          title="Aucune application en marche"
          hint="Déployez une application depuis la page Applications : elle apparaîtra ici dès qu'elle sera en ligne."
        />
      ) : (
        <AppsTable items={items} canRestart={auth.can('deployment:restart')} />
      )}
    </div>
  );
}
