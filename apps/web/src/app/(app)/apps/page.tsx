import {
  getAppSettings,
  listOpenBreaches,
  listSupervisedApps,
  listTargets,
  resolveThresholds,
  targetHistories,
} from '@pupitre/db';
import { Server } from 'lucide-react';
import { z } from 'zod';
import { LiveRefresh } from '@/components/realtime/live-refresh';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { getT } from '@/i18n/server';
import { servers as messages } from '@/i18n/messages/servers';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import type { SupervisedRow } from './apps-table';
import type { HostHistoryData, HistoryMetric } from './host-history';
import { runningAppRecord } from './record/record';
import { ServersList, type ServerRow } from './servers-list';

export const dynamic = 'force-dynamic';

/**
 * Fenêtre rendue avec la page. 24 h en 48 intervalles de 30 minutes : assez fin
 * pour voir un pic du week-end, assez grossier pour tenir dans une frise de
 * cent pixels sans transporter 288 valeurs par machine. Les 7 jours sont
 * demandés à la route, à la demande — personne n'ouvre cet écran pour eux.
 */
const HISTORY_HOURS = 24;
const HISTORY_BUCKETS = 48;

/**
 * Supervision, vue par serveur.
 *
 * Deux sources, jamais mélangées :
 *
 * - la **base** dit quelles machines sont déclarées et ce qui tourne dessus.
 *   Elle répond toujours, même quand toutes les machines sont éteintes ;
 * - la **machine** dit comment elle se porte *à l'instant*. Ce relevé est
 *   demandé par le navigateur, cible par cible, et son échec n'emporte rien
 *   d'autre que lui.
 *
 * C'est ce cloisonnement qui fait qu'un serveur injoignable garde ses
 * applications à l'écran.
 *
 * Depuis que les relevés sont conservés, la base a une troisième chose à dire :
 * **le passé de la machine**. Elle est rendue avec la page, côté serveur, et
 * pour une raison précise — c'est du SQL, pas du SSH. La courbe des dernières
 * 24 h s'affiche donc à l'identique que la machine réponde ou non, ce qui est
 * exactement le moment où on veut la lire.
 */
export default async function AppsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await requirePagePermission('/apps', 'deployment:read');
  const t = await getT(messages);
  const canReadTargets = auth.can('target:read');

  // Sans `target:read`, on ne liste pas le parc : les seuls serveurs affichés
  // sont ceux que les applications visibles citent déjà.
  const [apps, targets] = await Promise.all([
    listSupervisedApps(),
    canReadTargets ? listTargets() : Promise.resolve([]),
  ]);

  // L'historique ne concerne que les cibles réellement enregistrées : une
  // machine connue par le seul souvenir d'un déploiement n'a jamais été relevée.
  const targetIds = targets.map((target) => target.id);
  const [histories, openBreaches, thresholdsByTarget] = await Promise.all([
    targetHistories(targetIds, HISTORY_HOURS, HISTORY_BUCKETS),
    listOpenBreaches(targetIds),
    // Une résolution par machine : les seuils sont trois couches, et c'est la
    // base qui les empile (`resolveThresholds`). Recopier l'empilement ici en
    // aurait fait une seconde vérité.
    Promise.all(targetIds.map((id) => resolveThresholds(id))),
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

  const { settings } = await getAppSettings();

  // L'application ouverte (`?app=<id du déploiement>`) : sa console, dans le
  // tiroir — même si elle ne tourne plus, la fiche le dit.
  const wanted = (await searchParams).app;
  const record =
    typeof wanted === 'string' && z.string().uuid().safeParse(wanted).success
      ? await runningAppRecord(wanted, auth)
      : null;

  // Les données d'historique, mises en forme pour le client : des chaînes ISO
  // plutôt que des `Date`, et rien d'autre que ce que l'écran affiche.
  const history: Record<string, HostHistoryData> = {};
  targetIds.forEach((id, index) => {
    const window = histories.get(id);
    if (!window) return;
    const resolved = thresholdsByTarget[index];
    if (!resolved) return;
    history[id] = {
      hours: window.hours,
      samples: window.samples,
      reachable: window.reachable,
      points: window.points,
      summary: window.summary,
      thresholds: Object.fromEntries(
        (Object.keys(resolved) as HistoryMetric[]).map((metric) => [
          metric,
          {
            limitPercent: resolved[metric].limitPercent,
            enabled: resolved[metric].enabled,
            origin: resolved[metric].origin,
          },
        ]),
      ) as HostHistoryData['thresholds'],
      breaches: openBreaches
        .filter((breach) => breach.targetId === id)
        .map((breach) => ({
          id: breach.id,
          metric: breach.metric,
          startedAt: breach.startedAt.toISOString(),
          limitPercent: breach.limitPercent,
          peakValue: breach.peakValue,
          lastValue: breach.lastValue,
          samples: breach.samples,
        })),
    };
  });

  // L'en-tête vit dans la liste quand il y a des serveurs : son bouton « Tout
  // relever » pilote les relevés, qui sont un état client.
  if (rows.length === 0) {
    return (
      <>
        <PageHeader title={t('page.title')} description={t('page.description')} />
        <EmptyState
          icon={Server}
          title={t('page.empty')}
          hint={canReadTargets ? t('page.empty.hint') : t('page.empty.restricted')}
        />
      </>
    );
  }

  return (
    <>
      <LiveRefresh topics={['deployments', 'targets']} />
      <ServersList
        servers={rows}
        history={history}
        canRestart={auth.can('deployment:restart')}
        canReadTargets={canReadTargets}
        canTune={auth.can('target:update')}
        format={formatSettingsOf(settings)}
        record={record}
      />
    </>
  );
}
