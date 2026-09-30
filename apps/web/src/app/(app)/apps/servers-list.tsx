'use client';

import Link from 'next/link';
import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { RuntimesAvailable, TargetHealth, Translate } from '@pupitre/core';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import { State, type Tone } from '@/components/ui/led';
import { SegmentedControl } from '@/components/ui/segmented';
import { IconButton } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { servers as messages } from '@/i18n/messages/servers';
import type { FormatSettings } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { AppsTable, type SupervisedRow } from './apps-table';
import { HostHistory, OpenBreaches, type HostHistoryData } from './host-history';
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
 * relevés, et garde son dépliant intact — c'est précisément le moment où on a
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

type T = Translate<typeof messages.fr>;

const STATUS_KEY: Record<TargetHealth, keyof typeof messages.fr> = {
  unknown: 'status.unknown',
  ok: 'status.ok',
  degraded: 'status.degraded',
  unreachable: 'status.unreachable',
};

const STATUS_TONE: Record<TargetHealth, Tone> = {
  unknown: 'idle',
  ok: 'ok',
  degraded: 'warn',
  unreachable: 'danger',
};

/**
 * Une machine est « à surveiller » quand elle-même ne va pas bien, qu'un seuil
 * est franchi en ce moment, ou qu'une de ses applications est en peine — elle
 * répond mal, ou sa dernière mise à jour a échoué.
 */
function needsWatch(server: ServerRow, history: HostHistoryData | undefined): boolean {
  return (
    server.status === 'degraded' ||
    server.status === 'unreachable' ||
    (history?.breaches.length ?? 0) > 0 ||
    server.apps.some((app) => app.lastFailedUpdate !== null || app.healthStatus !== 'healthy')
  );
}

/** Depuis quand le relevé date. Un relevé sans âge affiché serait un relevé qu'on croit frais. */
function relevanceLabel(entry: MetricsEntry | undefined, t: T): string | null {
  if (entry === undefined || entry.state === 'loading') return null;
  const seconds = Math.max(0, Math.round((Date.now() - entry.at) / 1000));
  const ago =
    seconds < 60
      ? t('age.now')
      : seconds < 3600
        ? t('age.minutes', { count: Math.floor(seconds / 60) })
        : t('age.hours', { count: Math.floor(seconds / 3600) });
  return t('server.age', { ago });
}

function ServerCard({
  server,
  entry,
  history,
  canProbe,
  canRestart,
  canReadTargets,
  canTune,
  format,
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
  format: FormatSettings;
  onRefresh: () => void;
}) {
  const t = useT(messages);
  const hasApps = server.apps.length > 0;
  const age = relevanceLabel(entry, t);
  const probing = entry === undefined || entry.state === 'loading';

  const identity = (
    <>
      <span className="truncate font-semibold text-text">{server.name}</span>
      <span
        className="mono truncate text-[12px] text-text-3"
        title={`${server.sshUser ? `${server.sshUser}@` : ''}${server.host}${
          server.port === null ? '' : `:${server.port}`
        }`}
      >
        {server.host}
      </span>
    </>
  );

  return (
    // `data-server-id` : la seule façon de prouver le regroupement depuis
    // l'extérieur — le script de vérification découpe la page sur cet attribut
    // et vérifie qu'une application n'apparaît que sous sa cible.
    <section className="card overflow-hidden" aria-label={server.name} data-server-id={server.id}>
      <Collapsible defaultOpen>
        <div className="card-h flex-wrap gap-y-2 !px-4 !py-3">
          {hasApps ? (
            <CollapsibleTrigger className="min-w-0 gap-2.5">{identity}</CollapsibleTrigger>
          ) : (
            // Pas de dépliant sur un serveur vide : ouvrir pour ne rien trouver
            // est une promesse non tenue. Le badge, à côté, dit déjà tout.
            <span className="flex min-w-0 items-center gap-2.5 pl-[26px]">{identity}</span>
          )}
          <State tone={STATUS_TONE[server.status]}>{t(STATUS_KEY[server.status])}</State>
          <Badge>{t('server.apps', { count: server.apps.length })}</Badge>

          <span className="ml-auto flex items-center gap-1.5">
            {age ? <span className="t-cap text-text-3">{age}</span> : null}
            {canProbe ? (
              <IconButton
                label={t('server.probe.tip')}
                size="icon-sm"
                disabled={probing}
                onClick={onRefresh}
              >
                <RefreshCw className={cn(probing && 'animate-spin motion-reduce:animate-none')} />
              </IconButton>
            ) : null}
            {canTune && history ? (
              <ThresholdsDialog
                targetId={server.id}
                targetName={server.name}
                thresholds={history.thresholds}
              />
            ) : null}
            {server.registered && canReadTargets ? (
              <Button asChild size="sm" variant="secondary">
                <Link href={`/targets/${server.id}`}>{t('server.details')}</Link>
              </Button>
            ) : null}
          </span>
        </div>

        <HostReadouts
          entry={entry}
          enabled={canProbe}
          thresholds={history?.thresholds}
          summary={history?.summary}
        />

        {history ? (
          <>
            <OpenBreaches breaches={history.breaches} />
            <HostHistory
              targetId={server.id}
              initial={history}
              format={format}
              defaultOpen={server.status === 'unreachable' || history.breaches.length > 0}
            />
          </>
        ) : null}

        {hasApps ? (
          <CollapsiblePanel className="border-t border-border-subtle">
            <AppsTable items={server.apps} canRestart={canRestart} />
          </CollapsiblePanel>
        ) : (
          <p className="t-sm border-t border-border-subtle px-4 py-3 text-text-2">
            {t('server.noApps')}
          </p>
        )}
      </Collapsible>
    </section>
  );
}

export function ServersList({
  servers,
  history,
  canRestart,
  canReadTargets,
  canTune,
  format,
}: {
  servers: ServerRow[];
  /** L'historique, par identifiant de cible. Vient de la base, avec la page. */
  history: Record<string, HostHistoryData>;
  canRestart: boolean;
  /** Sans `target:read`, aucun relevé n'est demandé : la route le refuserait. */
  canReadTargets: boolean;
  canTune: boolean;
  /** Le formatage descend par props : cette liste est cliente, la locale non. */
  format: FormatSettings;
}) {
  const t = useT(messages);
  const [filter, setFilter] = useState<'all' | 'watch'>('all');

  // Seules les cibles réellement enregistrées peuvent être relevées : une
  // machine connue par le seul souvenir d'un déploiement n'a plus de credential.
  const probeIds = canReadTargets
    ? servers.filter((server) => server.registered).map((server) => server.id)
    : [];

  const { entries, refresh, refreshAll } = useHostMetrics(probeIds, canReadTargets);
  const busy = probeIds.some((id) => entries[id] === undefined || entries[id]?.state === 'loading');

  const watched = servers.filter((server) => needsWatch(server, history[server.id]));
  const shown = filter === 'watch' ? watched : servers;

  return (
    <>
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={
          probeIds.length > 0 ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                toast({
                  title: t('list.probeAll.toast', { count: probeIds.length }),
                  description: t('list.probeAll.toast.detail'),
                  tone: 'accent',
                });
                void refreshAll();
              }}
            >
              <RefreshCw className={cn(busy && 'animate-spin motion-reduce:animate-none')} />
              {busy ? t('readout.pending') : t('list.probeAll')}
            </Button>
          ) : null
        }
      />

      <div className="t-sm flex flex-wrap items-center gap-2 text-text-3">
        {`${t('list.servers', { count: servers.length })} · ${t('list.apps', {
          count: servers.reduce((total, server) => total + server.apps.length, 0),
        })}`}
        <SegmentedControl
          className="ml-auto"
          label={t('list.filter.label')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('list.filter.all') },
            { value: 'watch', label: t('list.filter.watch', { count: watched.length }) },
          ]}
        />
      </div>

      {shown.length === 0 ? <p className="t-sm text-text-3">{t('list.filter.none')}</p> : null}

      {shown.map((server) => (
        <ServerCard
          key={server.id}
          server={server}
          entry={entries[server.id]}
          history={history[server.id]}
          canProbe={canReadTargets && server.registered}
          canRestart={canRestart}
          canReadTargets={canReadTargets}
          canTune={canTune && server.registered}
          format={format}
          onRefresh={() => void refresh(server.id)}
        />
      ))}
    </>
  );
}
