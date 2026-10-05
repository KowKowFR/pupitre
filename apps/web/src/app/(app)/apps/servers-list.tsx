'use client';

import Link from 'next/link';
import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { RuntimesAvailable, TargetHealth, Translate } from '@pupitre/core';
import { PageHeader } from '@/components/page-header';
import { useRecordSelection } from '@/components/record-drawer';
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
import { AppDrawer, type RunningAppRecordView } from './app-drawer';
import { AppsTable, type SupervisedRow } from './apps-table';
import { HostHistory, OpenBreaches, type HostHistoryData } from './host-history';
import { HostReadouts } from './host-readouts';
import { ThresholdsDialog } from './thresholds-dialog';
import { useHostMetrics, type MetricsEntry } from './use-host-metrics';

/**
 * The servers, and under each one its applications.
 *
 * The screen is built in that direction: a machine exists independently of what
 * it carries, whereas an application exists nowhere without a machine. Listing
 * the applications flat forced one to read the "Target" column row after row to
 * rebuild the fleet mentally.
 *
 * **An unreachable machine does not make its applications disappear.** The list
 * of applications comes from the database, the reading comes from the machine:
 * they are two sources, and the second one's failure must never erase the first.
 * A server turned off therefore shows "unreachable" in place of its readings,
 * and keeps its disclosure intact — it is precisely the moment one needs to know
 * what was supposed to run there.
 *
 * **And it also keeps its past.** The history is a third source — the database,
 * again — rendered with the page. A machine that no longer answers therefore
 * shows "unreachable" *above* the curve of the last 24 h, the one that perhaps
 * says why it no longer answers.
 */

export type ServerRow = {
  id: string;
  name: string;
  host: string;
  port: number | null;
  sshUser: string | null;
  status: TargetHealth;
  /** `null` when the target is only known through the deployments that mention it. */
  runtimes: RuntimesAvailable | null;
  /** The target is in the `targets` table and can therefore be read. */
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
 * A machine is "to watch" when it is not doing well itself, a threshold is
 * crossed right now, or one of its applications is struggling — it answers
 * badly, or its last update failed.
 */
function needsWatch(server: ServerRow, history: HostHistoryData | undefined): boolean {
  return (
    server.status === 'degraded' ||
    server.status === 'unreachable' ||
    (history?.breaches.length ?? 0) > 0 ||
    server.apps.some((app) => app.lastFailedUpdate !== null || app.healthStatus !== 'healthy')
  );
}

/** How old the reading is. A reading without a displayed age would be believed fresh. */
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
  onOpen,
}: {
  server: ServerRow;
  entry: MetricsEntry | undefined;
  /** Absent when the machine is not a registered target: nothing to read again. */
  history: HostHistoryData | undefined;
  canProbe: boolean;
  canRestart: boolean;
  canReadTargets: boolean;
  /** `target:update`: setting a threshold is describing the machine. */
  canTune: boolean;
  format: FormatSettings;
  onRefresh: () => void;
  onOpen: (id: string) => void;
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
    // `data-server-id`: the only way to prove the grouping from the outside — the
    // verification script cuts the page on this attribute and checks that an
    // application only appears under its target.
    <section className="card overflow-hidden" aria-label={server.name} data-server-id={server.id}>
      <Collapsible defaultOpen>
        <div className="card-h flex-wrap gap-y-2 !px-4 !py-3">
          {hasApps ? (
            <CollapsibleTrigger className="min-w-0 gap-2.5">{identity}</CollapsibleTrigger>
          ) : (
            // No disclosure on an empty server: opening it to find nothing is a broken
            // promise. The badge, next to it, already says everything.
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
                <Link href={`/targets?target=${server.id}`}>{t('server.details')}</Link>
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
            <AppsTable items={server.apps} canRestart={canRestart} onOpen={onOpen} />
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
  record,
}: {
  servers: ServerRow[];
  /** The history, per target identifier. Comes from the database, with the page. */
  history: Record<string, HostHistoryData>;
  canRestart: boolean;
  /** Without `target:read`, no reading is requested: the route would refuse it. */
  canReadTargets: boolean;
  canTune: boolean;
  /** Formatting comes down through props: this list is a client one, the locale is not. */
  format: FormatSettings;
  /** The open application, rendered on the server. */
  record: RunningAppRecordView | null;
}) {
  const t = useT(messages);
  const [filter, setFilter] = useState<'all' | 'watch'>('all');
  const apps = servers.flatMap((server) => server.apps);
  const drawer = useRecordSelection(
    'app',
    apps.map((app) => app.id),
  );
  const current = apps.find((app) => app.id === drawer.selected) ?? null;

  // Only the targets really registered can be read: a machine known only through
  // a deployment's memory no longer has a credential.
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
          onOpen={drawer.open}
        />
      ))}

      <AppDrawer
        selected={drawer.selected}
        row={current}
        record={drawer.loading ? null : record}
        onClose={drawer.close}
        onPrevious={drawer.onPrevious}
        onNext={drawer.onNext}
      />
    </>
  );
}
