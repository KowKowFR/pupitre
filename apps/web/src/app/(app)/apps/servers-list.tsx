'use client';

import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import type { RuntimesAvailable, TargetHealth } from '@pupitre/core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { RuntimeBadges } from '../targets/runtime-badges';
import { AppsTable, HealthDot, type HealthStatus, type SupervisedRow } from './apps-table';
import { HostHistory, type HostHistoryData } from './host-history';
import { HostReadouts } from './host-readouts';
import { ThresholdsDialog } from './thresholds-dialog';
import { useHostMetrics, type MetricsEntry } from './use-host-metrics';

/**
 * Les serveurs, et sous chacun ses applications.
 *
 * L'écran est bâti dans ce sens-là : une machine existe indépendamment de ce
 * qu'elle porte, alors qu'une application n'existe nulle part sans machine.
 * Lister les applications à plat obligeait à relire la colonne « Cible » ligne
 * après ligne pour reconstituer mentalement le parc.
 *
 * **Une machine injoignable ne fait pas disparaître ses applications.** La
 * liste des applications vient de la base, le relevé vient de la machine : ce
 * sont deux sources, et l'échec de la seconde ne doit jamais effacer la
 * première. Un serveur éteint affiche donc « injoignable » à la place de ses
 * jauges, et garde son dépliant intact — c'est précisément le moment où on a
 * besoin de savoir ce qui était censé y tourner.
 *
 * **Et il garde aussi son passé.** L'historique est une troisième source — la
 * base, encore — rendue avec la page. Une machine qui ne répond plus affiche
 * donc « injoignable » *au-dessus* de la courbe des dernières 24 h, celle qui
 * dit peut-être pourquoi elle ne répond plus.
 */

export type ServerRow = {
  id: string;
  name: string;
  host: string;
  port: number | null;
  sshUser: string | null;
  status: TargetHealth;
  /** `null` quand la cible n'est connue que par les déploiements qui la citent. */
  runtimes: RuntimesAvailable | null;
  /** La cible figure dans la table `targets` et peut donc être relevée. */
  registered: boolean;
  apps: SupervisedRow[];
};

const STATUS_LABEL: Record<TargetHealth, string> = {
  unknown: 'jamais testée',
  ok: 'opérationnelle',
  degraded: 'dégradée',
  unreachable: 'injoignable',
};

/**
 * L'état d'une machine, dit avec le même voyant que celui des applications.
 * `ok → healthy`, `degraded → unhealthy` : deux vocabulaires, une seule
 * convention de lecture.
 */
const STATUS_HEALTH: Record<TargetHealth, HealthStatus> = {
  unknown: 'unknown',
  ok: 'healthy',
  degraded: 'unhealthy',
  unreachable: 'unreachable',
};

function appCountLabel(count: number): string {
  if (count === 0) return 'aucune application';
  return `${count} application${count > 1 ? 's' : ''}`;
}

/** Depuis quand le relevé date. Un relevé sans âge affiché serait un relevé qu'on croit frais. */
function relevanceLabel(entry: MetricsEntry | undefined): string | null {
  if (entry === undefined || entry.state === 'loading') return null;
  const seconds = Math.max(0, Math.round((Date.now() - entry.at) / 1000));
  if (seconds < 60) return "à l'instant";
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  return `il y a ${Math.floor(seconds / 3600)} h`;
}

function ServerCard({
  server,
  entry,
  history,
  canProbe,
  canRestart,
  canReadTargets,
  canTune,
  onRefresh,
}: {
  server: ServerRow;
  entry: MetricsEntry | undefined;
  /** Absent quand la machine n'est pas une cible enregistrée : rien à relire. */
  history: HostHistoryData | undefined;
  canProbe: boolean;
  canRestart: boolean;
  canReadTargets: boolean;
  /** `target:update` : régler un seuil, c'est décrire la machine. */
  canTune: boolean;
  onRefresh: () => void;
}) {
  const hasApps = server.apps.length > 0;

  // Un serveur qui porte une application en peine s'ouvre de lui-même : c'est
  // la seule ligne de l'écran qu'on voulait vraiment voir en arrivant.
  const needsAttention = server.apps.some(
    (app) => app.lastFailedUpdate !== null || app.healthStatus !== 'healthy',
  );

  const age = relevanceLabel(entry);
  const probing = entry === undefined || entry.state === 'loading';

  const identity = (
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-[0.8125rem] font-medium text-ink">{server.name}</span>
      <span className="truncate font-mono text-[0.6875rem] text-ink-faint">
        {server.sshUser ? `${server.sshUser}@` : ''}
        {server.host}
        {server.port === null ? '' : `:${server.port}`}
      </span>
    </span>
  );

  return (
    // `data-server-id` : la seule façon de prouver le regroupement depuis
    // l'extérieur — le script de vérification découpe la page sur cet attribut
    // et vérifie qu'une application n'apparaît que sous sa cible.
    <Card className="gap-0 overflow-hidden py-0" data-server-id={server.id}>
      <Collapsible defaultOpen={hasApps && needsAttention}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          {hasApps ? (
            <CollapsibleTrigger className="min-w-0 flex-1 basis-56 hover:[&_span:first-of-type]:text-signal">
              {identity}
            </CollapsibleTrigger>
          ) : (
            // Pas de dépliant sur un serveur vide : ouvrir pour ne rien trouver
            // est une promesse non tenue. Le compte, à droite, dit déjà tout.
            <span className="flex min-w-0 flex-1 basis-56 items-center gap-1.5 pl-[1.375rem]">
              {identity}
            </span>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <HealthDot
              health={STATUS_HEALTH[server.status]}
              label={STATUS_LABEL[server.status]}
            />
            {server.runtimes ? <RuntimeBadges runtimes={server.runtimes} /> : null}
            <Badge variant={hasApps ? 'outline' : 'secondary'} className="text-[10px]">
              {appCountLabel(server.apps.length)}
            </Badge>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {age ? <span className="text-[0.6875rem] text-ink-faint">{age}</span> : null}
            {canProbe ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={probing}
                onClick={onRefresh}
                aria-label={`Relever les métriques de ${server.name}`}
              >
                <RefreshCw className={cn(probing && 'animate-spin')} />
                {probing ? 'Relevé…' : 'Relever'}
              </Button>
            ) : null}
            {canTune && history ? (
              <ThresholdsDialog
                targetId={server.id}
                targetName={server.name}
                thresholds={history.thresholds}
              />
            ) : null}
            {server.registered && canReadTargets ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/targets/${server.id}`}>Fiche</Link>
              </Button>
            ) : null}
          </div>
        </div>

        <div className="border-t border-line bg-ground-deep/40 px-1 py-1">
          <HostReadouts entry={entry} enabled={canProbe} thresholds={history?.thresholds} />
        </div>

        {history ? (
          <div className="border-t border-line bg-ground-deep/20">
            <HostHistory targetId={server.id} initial={history} />
          </div>
        ) : null}

        {hasApps ? (
          <CollapsiblePanel className="border-t border-line px-4 py-3">
            <AppsTable items={server.apps} canRestart={canRestart} />
          </CollapsiblePanel>
        ) : (
          <p className="border-t border-line px-4 py-3 text-[0.8125rem] text-ink-muted">
            Aucune application supervisée sur cette machine. Déployez-en une depuis la page
            Applications : elle apparaîtra ici.
          </p>
        )}
      </Collapsible>
    </Card>
  );
}

export function ServersList({
  servers,
  history,
  canRestart,
  canReadTargets,
  canTune,
}: {
  servers: ServerRow[];
  /** L'historique, par identifiant de cible. Vient de la base, avec la page. */
  history: Record<string, HostHistoryData>;
  canRestart: boolean;
  /** Sans `target:read`, aucun relevé n'est demandé : la route le refuserait. */
  canReadTargets: boolean;
  canTune: boolean;
}) {
  // Seules les cibles réellement enregistrées peuvent être relevées : une
  // machine connue par le seul souvenir d'un déploiement n'a plus de credential.
  const probeIds = canReadTargets
    ? servers.filter((server) => server.registered).map((server) => server.id)
    : [];

  const { entries, refresh, refreshAll } = useHostMetrics(probeIds, canReadTargets);
  const busy = probeIds.some((id) => entries[id] === undefined || entries[id]?.state === 'loading');

  return (
    <div className="flex flex-col gap-4">
      {canReadTargets && probeIds.length > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[0.75rem] text-ink-faint">
            {servers.length} serveur{servers.length > 1 ? 's' : ''} ·{' '}
            {servers.reduce((total, server) => total + server.apps.length, 0)} application(s)
            supervisée(s)
          </p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void refreshAll()}>
            <RefreshCw className={cn(busy && 'animate-spin')} />
            {busy ? 'Relevé en cours…' : 'Tout relever'}
          </Button>
        </div>
      ) : null}

      {servers.map((server) => (
        <ServerCard
          key={server.id}
          server={server}
          entry={entries[server.id]}
          history={history[server.id]}
          canProbe={canReadTargets && server.registered}
          canRestart={canRestart}
          canReadTargets={canReadTargets}
          canTune={canTune && server.registered}
          onRefresh={() => void refresh(server.id)}
        />
      ))}
    </div>
  );
}
