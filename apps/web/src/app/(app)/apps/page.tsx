import { listSupervisedApps, listTargets } from '@pupitre/db';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { requirePagePermission } from '@/lib/page-auth';
import type { SupervisedRow } from './apps-table';
import { ServersList, type ServerRow } from './servers-list';

export const dynamic = 'force-dynamic';

/**
 * Supervision, vue par serveur.
 *
 * Deux sources, jamais mélangées :
 *
 * - la **base** dit quelles machines sont déclarées et ce qui tourne dessus.
 *   Elle répond toujours, même quand toutes les machines sont éteintes ;
 * - la **machine** dit comment elle se porte. Ce relevé est demandé par le
 *   navigateur, cible par cible, et son échec n'emporte rien d'autre que lui.
 *
 * C'est ce cloisonnement qui fait qu'un serveur injoignable garde ses
 * applications à l'écran.
 */
export default async function AppsPage() {
  const auth = await requirePagePermission('/apps', 'deployment:read');
  const canReadTargets = auth.can('target:read');

  // Sans `target:read`, on ne liste pas le parc : les seuls serveurs affichés
  // sont ceux que les applications visibles citent déjà.
  const [apps, targets] = await Promise.all([
    listSupervisedApps(),
    canReadTargets ? listTargets() : Promise.resolve([]),
  ]);

  const items: SupervisedRow[] = apps.map((app) => ({
    id: app.id,
    applicationSlug: app.applicationSlug,
    targetId: app.targetId,
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
    // Préservé tel quel : une application dont la dernière mise à jour a échoué
    // reste visible, avec la mention de l'échec. La faire disparaître était le
    // défaut qu'on a corrigé, et le regroupement par serveur ne le réintroduit pas.
    lastFailedUpdate: app.lastFailedUpdate
      ? {
          deploymentId: app.lastFailedUpdate.deploymentId,
          version: app.lastFailedUpdate.version,
          failedStep: app.lastFailedUpdate.failedStep,
          mayHaveReplacedServices: app.lastFailedUpdate.mayHaveReplacedServices,
        }
      : null,
  }));

  const servers = new Map<string, ServerRow>();

  for (const target of targets) {
    servers.set(target.id, {
      id: target.id,
      name: target.name,
      host: target.host,
      port: target.port,
      sshUser: target.sshUser,
      status: target.status,
      runtimes: target.runtimesAvailable,
      registered: true,
      apps: [],
    });
  }

  for (const app of items) {
    // Une cible absente de la liste ci-dessus : soit le lecteur n'a pas
    // `target:read`, soit la ligne a disparu de la table. Dans les deux cas
    // l'application reste affichée sous le nom que son déploiement a gardé —
    // mieux vaut un serveur sans fiche qu'une application orpheline.
    const existing = servers.get(app.targetId);
    if (existing) {
      existing.apps.push(app);
      continue;
    }
    servers.set(app.targetId, {
      id: app.targetId,
      name: app.targetName,
      host: app.targetHost,
      port: null,
      sshUser: null,
      status: 'unknown',
      runtimes: null,
      registered: false,
      apps: [app],
    });
  }

  const rows = [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Supervision"
        title="Serveurs et applications"
        description="Une ligne par machine : comment elle se porte, et ce qu'elle porte. Dépliez un serveur pour voir ses applications. Une application dont la dernière mise à jour a échoué reste listée — elle tourne toujours, dans sa version précédente. L'historique des déploiements est ailleurs."
      />

      {rows.length === 0 ? (
        <EmptyState
          title="Aucun serveur à superviser"
          hint={
            canReadTargets
              ? 'Déclarez une machine cible, puis déployez-y une application : les deux apparaîtront ici.'
              : "Aucune application en marche n'est visible avec vos permissions."
          }
        />
      ) : (
        <ServersList
          servers={rows}
          canRestart={auth.can('deployment:restart')}
          canReadTargets={canReadTargets}
        />
      )}
    </div>
  );
}
