import Link from 'next/link';
import { Hourglass, Info } from 'lucide-react';
import { deploymentStepLabel, type Translate } from '@pupitre/core';
import {
  activityPulse,
  foldFleet,
  getAppSettings,
  HOST_METRIC_CATALOG,
  monitorPulse,
  listMaintenanceWindows,
  pulseWindow,
  targetHistories,
  type ActivityPulse,
  type DeploymentPulse,
  type DeploymentSummary,
  type FleetPulse,
  type MonitorPulse,
  type PublicTarget,
  type ScanPosture,
  type SupervisedApp,
  type TargetHistory,
} from '@pupitre/db';
import {
  densityOf,
  EventRail,
  MicroSpark,
  MiniGauge,
  NotEnoughHistory,
  RatioBars,
  SeriesLine,
  TimeAxis,
  type TimelineEvent,
} from '@/components/chart';
import { LiveRefresh } from '@/components/realtime/live-refresh';
import { Led, Readout, ReadoutBar, type Tone } from '@/components/instrument';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { DeployButton } from '@/components/shell/deploy-button';
import { RuntimePill } from '@/components/ui/badge';
import { SegmentedLinks } from '@/components/ui/segmented';
import { currentLanguage, getT } from '@/i18n/server';
import { dashboard } from '@/i18n/messages/dashboard';
import { formatNumber, formatSettingsOf, type FormatSettings } from '@/lib/format';
import {
  CHRONICLE_DAYS,
  collectAttention,
  loadApplications,
  loadDeploymentPulse,
  loadMonitors,
  loadRecentDeployments,
  loadScanPosture,
  loadSupervisedApps,
  loadTargets,
} from '@/lib/overview';
import { currentAuth } from '@/lib/page-auth';
import { isTeamMember } from '@/lib/rbac';
import { ForecastPanel } from '@/components/forecasts/forecast-panel';
import { MaintenanceBanner } from '@/components/maintenance/maintenance-banner';
import { maintenanceJson, visibleCoverage } from '@/lib/maintenance';
import { visibleForecasts } from '@/lib/forecasts';
import { AttentionPanel, Panel, PanelEmpty } from './attention';
import { DeploymentStatusBadge } from './deployments/status-badge';

export const dynamic = 'force-dynamic';

/**
 * The overview. Three questions, in this order, and the screen answers nothing
 * else:
 *
 *   1. **Must one intervene?** — the attention block, at the top.
 *   2. **What happened?** — the window (24 h or 7 days): four readouts, then four
 *      tracks on a shared axis.
 *   3. **What state is the fleet in?** — the machines, what runs, the last
 *      deployments, then the inventory that closes the screen.
 *
 * Everything a permission forbids disappears: a track, a card, a button. Nothing
 * is greyed out.
 */

/** The two observation windows: 24 one-hour buckets, or 28 six-hour ones. */
const WINDOWS = {
  day: { hours: 24, buckets: 24 },
  week: { hours: 168, buckets: 28 },
} as const;

type WindowKey = keyof typeof WINDOWS;

/** The floor under which a rate is only a count: 20 measurements. */
const RATE_FLOOR = 20;

const HEALTH_TONE: Record<string, Tone> = {
  healthy: 'ok',
  unhealthy: 'warn',
  unreachable: 'danger',
  unknown: 'idle',
};

const TARGET_TONE: Record<PublicTarget['status'], Tone> = {
  ok: 'ok',
  degraded: 'warn',
  unreachable: 'danger',
  unknown: 'idle',
};

type MessageKey = keyof typeof dashboard.fr;
type T = Translate<typeof dashboard.fr>;

const HEALTH_KEY: Record<string, MessageKey | undefined> = {
  healthy: 'health.healthy',
  unhealthy: 'health.unhealthy',
  unreachable: 'health.unreachable',
  unknown: 'health.unknown',
};

const STATUS_KEY: Record<string, MessageKey | undefined> = {
  success: 'status.success',
  failed: 'status.failed',
  rolled_back: 'status.rolled_back',
  destroyed: 'status.destroyed',
  running: 'status.running',
  pending: 'status.pending',
};

const DEPLOYMENT_TONE: Record<string, Tone> = {
  success: 'ok',
  failed: 'danger',
  rolled_back: 'warn',
  destroyed: 'idle',
  running: 'accent',
  pending: 'accent',
};

function labelOf(catalog: Record<string, MessageKey | undefined>, status: string, t: T): string {
  const key = catalog[status];
  return key === undefined ? status : t(key);
}

/** "3 min ago". Returns `null` rather than a dash: the caller decides. */
function since(date: Date | null, t: T): string | null {
  if (!date) return null;
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return t('since.seconds', { count: seconds });
  if (seconds < 3600) return t('since.minutes', { count: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t('since.hours', { count: Math.floor(seconds / 3600) });
  return t('since.days', { count: Math.floor(seconds / 86_400) });
}

/** "74 s", "1 min 52 s". */
function duration(seconds: number, t: T): string {
  if (seconds < 90) return t('duration.seconds', { seconds });
  return t('duration.minutes', {
    minutes: Math.floor(seconds / 60),
    seconds: String(seconds % 60).padStart(2, '0'),
  });
}

/** The median of a sparse series. `null` under three values — two have none. */
function median(values: readonly (number | null)[]): number | null {
  const clean = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (clean.length < 3) return null;
  return clean[Math.floor(clean.length / 2)] ?? null;
}

/**
 * The band's windows: ongoing, and upcoming within the day — only those of which
 * the session reads at least one subject.
 */
function bannerWindows(
  windows: Awaited<ReturnType<typeof listMaintenanceWindows>>,
  auth: Parameters<typeof maintenanceJson>[1],
) {
  const soon = Date.now() + 24 * 3_600_000;
  return windows
    .map((window) => maintenanceJson(window, auth))
    .filter(
      (window) =>
        window.targets.length + window.monitors.length > 0 &&
        (window.phase === 'active' || new Date(window.startsAt).getTime() <= soon),
    );
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await currentAuth('/');
  const t = await getT(dashboard);

  // An account without any permission waits for an administrator to choose it a
  // role. The template listens to the `users` topic: an assigned role reads the
  // page again, which then opens by itself.
  if (auth && !isTeamMember(auth)) {
    return (
      <>
        <PageHeader title={t('page.title')} />
        <EmptyState icon={Hourglass} title={t('noAccess.title')} hint={t('noAccess.hint')} />
      </>
    );
  }
  const windowKey: WindowKey = (await searchParams).window === '7d' ? 'week' : 'day';
  const { hours, buckets } = WINDOWS[windowKey];

  const canReadTargets = auth?.can('target:read') ?? false;
  const canReadDeployments = auth?.can('deployment:read') ?? false;
  const canReadApplications = auth?.can('application:read') ?? false;
  const canReadMonitors = auth?.can('monitor:read') ?? false;
  const canReadScans = auth?.can('scan:read') ?? false;
  const canReadAudit = auth?.can('audit:read') ?? false;
  const canDeploy = auth?.can('deployment:create') ?? false;

  const window = pulseWindow(hours, buckets);

  // The targets first: their identifiers condition the fleet's history.
  const targets = canReadTargets ? await loadTargets() : ([] as PublicTarget[]);

  // Formatting comes down through props to the figures: the instance's locale
  // decides "00:33" as well as "12,345", everywhere on the screen.
  const { settings } = await getAppSettings();
  const format = formatSettingsOf(settings);

  const [
    deployments,
    applications,
    running,
    monitors,
    pulse,
    activity,
    chronicle,
    posture,
    histories,
  ] = await Promise.all([
    canReadDeployments ? loadRecentDeployments() : Promise.resolve(null),
    canReadApplications ? loadApplications() : Promise.resolve([]),
    canReadDeployments ? loadSupervisedApps() : Promise.resolve([] as SupervisedApp[]),
    canReadMonitors ? loadMonitors() : Promise.resolve([]),
    canReadMonitors ? monitorPulse(hours, buckets) : Promise.resolve(null),
    canReadAudit ? activityPulse(hours, buckets) : Promise.resolve(null),
    canReadDeployments ? loadDeploymentPulse() : Promise.resolve(null),
    canReadScans ? loadScanPosture() : Promise.resolve(null),
    canReadTargets
      ? targetHistories(
          targets.map((target) => target.id),
          hours,
          buckets,
        )
      : Promise.resolve(new Map<string, TargetHistory>()),
  ]);

  const fleet = canReadTargets ? foldFleet(histories.values(), window) : null;

  const recent: DeploymentSummary[] = deployments?.items ?? [];
  const inFlight = recent.filter((item) => item.status === 'running' || item.status === 'pending');
  const targetsUp = targets.filter((target) => target.status === 'ok').length;
  // A target never tested is not a broken target: it is an installation that was
  // not finished. Confusing them made the same screen say two opposite things.
  const targetsUntested = targets.filter((target) => target.status === 'unknown').length;
  const targetsDown = targets.length - targetsUp - targetsUntested;
  const monitorsUp = monitors.filter((monitor) => monitor.status === 'healthy').length;
  const appsHealthy = running.filter((app) => app.healthStatus === 'healthy').length;

  const [forecasts, coverage, windows] = await Promise.all([
    auth ? visibleForecasts(auth) : Promise.resolve([]),
    auth ? visibleCoverage(auth) : Promise.resolve(null),
    auth ? listMaintenanceWindows({ endedLimit: 0 }) : Promise.resolve([]),
  ]);
  const attention = collectAttention({
    targets,
    running,
    monitors,
    recent,
    chronicle,
    posture,
    maintenance: coverage
      ? { targets: new Set(coverage.targets.keys()), monitors: new Set(coverage.monitors.keys()) }
      : undefined,
    t,
  });
  const maintenance = auth ? bannerWindows(windows, auth) : [];

  return (
    <>
      <LiveRefresh />
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={
          <>
            <SegmentedLinks
              label={t('window.label')}
              options={[
                { href: '/', label: t('window.day'), active: windowKey === 'day' },
                { href: '/?window=7d', label: t('window.week'), active: windowKey === 'week' },
              ]}
            />
            {canDeploy ? <DeployButton label={t('page.deploy')} /> : null}
          </>
        }
      />

      <MaintenanceBanner
        windows={maintenance}
        format={format}
        canRead={auth?.can('maintenance:read') ?? false}
      />

      <AttentionPanel items={attention} />

      {/* What will break if nothing changes: under what is broken now. */}
      <ForecastPanel items={forecasts} />

      <PulseBand
        windowKey={windowKey}
        window={window}
        pulse={pulse}
        fleet={fleet}
        activity={activity}
        chronicle={chronicle}
        posture={posture}
        canReadMonitors={canReadMonitors}
        canReadTargets={canReadTargets}
        canReadDeployments={canReadDeployments}
        canReadAudit={canReadAudit}
        format={format}
      />

      {canReadTargets ? (
        <FleetPanel
          targets={targets}
          histories={histories}
          running={running}
          windowKey={windowKey}
        />
      ) : null}

      {/*
        `items-start`: these two blocks have no reason to have the same
        height. Stretched, a one-row list ended up in the middle of a big
        void.
             */}
      {canReadDeployments ? (
        <div className="grid grid-cols-1 min-w-0 items-start gap-6 lg:grid-cols-[1fr_1.25fr]">
          <Panel
            title={t('running.title')}
            aside={
              running.length > 6
                ? t('running.aside', { shown: 6, total: running.length })
                : undefined
            }
            href="/apps"
            linkLabel={t('link.all')}
          >
            {running.length === 0 ? (
              <PanelEmpty>
                {t('running.empty')}{' '}
                <Link href="/applications" className="link">
                  {t('link.applications')}
                </Link>
                .
              </PanelEmpty>
            ) : (
              <ul className="list">
                {running.slice(0, 6).map((app) => (
                  <li key={app.id}>
                    <Led tone={HEALTH_TONE[app.healthStatus] ?? 'idle'} />
                    <Link
                      href={`/apps?app=${app.id}`}
                      className="mono min-w-0 flex-1 truncate text-[12.5px] text-text hover:underline"
                    >
                      {app.applicationSlug}
                      <span className="text-text-3">@{app.targetName}</span>
                    </Link>
                    <span className="t-cap shrink-0 text-text-3">
                      {labelOf(HEALTH_KEY, app.healthStatus, t)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <DeploymentsPanel recent={recent} chronicle={chronicle} />
        </div>
      ) : null}

      {/*
        The inventory closes the screen instead of opening it: these figures
        reassure, they trigger nothing.
             */}
      <ReadoutBar>
        {canReadTargets ? (
          <Readout
            label={t('readout.targets')}
            value={targetsUp}
            unit={`/ ${targets.length}`}
            tone={
              targets.length === 0
                ? 'idle'
                : targetsDown > 0
                  ? 'warn'
                  : targetsUntested > 0
                    ? 'idle'
                    : 'ok'
            }
            hint={targetsHint({ targetsDown, targetsUntested }, t)}
          />
        ) : null}
        {canReadDeployments ? (
          <Readout
            label={t('readout.apps')}
            value={appsHealthy}
            unit={`/ ${running.length}`}
            tone={running.length === 0 ? 'idle' : appsHealthy === running.length ? 'ok' : 'warn'}
            hint={t('readout.apps.declared', { count: applications.length })}
          />
        ) : null}
        {canReadMonitors ? (
          <Readout
            label={t('readout.monitors')}
            value={monitorsUp}
            unit={`/ ${monitors.length}`}
            tone={monitors.length === 0 ? 'idle' : monitorsUp === monitors.length ? 'ok' : 'warn'}
            hint={t('readout.monitors.hint')}
          />
        ) : null}
        {canReadDeployments ? (
          <Readout
            label={t('readout.inFlight')}
            value={inFlight.length}
            tone={inFlight.length > 0 ? 'accent' : 'idle'}
            pulse={inFlight.length > 0}
            hint={
              inFlight[0]
                ? `${inFlight[0].applicationSlug} v${inFlight[0].version} · ${inFlight[0].targetName}`
                : t('readout.inFlight.off')
            }
          />
        ) : null}
      </ReadoutBar>
    </>
  );
}

// ─── the window ───────────────────────────────────────────────────────────────

/**
 * The observation window, on a single axis.
 *
 * The tracks share exactly the same bucket bounds — it is guaranteed by
 * `pulseWindow`, whose alignment is the same as `targetHistories`'. That is what
 * allows reading vertically: the 00:33 deployment falls above the 00:33 load dip.
 */
async function PulseBand({
  windowKey,
  window,
  pulse,
  fleet,
  activity,
  chronicle,
  posture,
  canReadMonitors,
  canReadTargets,
  canReadDeployments,
  canReadAudit,
  format,
}: {
  windowKey: WindowKey;
  window: ReturnType<typeof pulseWindow>;
  pulse: MonitorPulse | null;
  fleet: FleetPulse | null;
  activity: ActivityPulse | null;
  chronicle: DeploymentPulse | null;
  posture: ScanPosture | null;
  canReadMonitors: boolean;
  canReadTargets: boolean;
  canReadDeployments: boolean;
  canReadAudit: boolean;
  format: FormatSettings;
}) {
  const t = await getT(dashboard);
  const title = windowKey === 'week' ? t('band.title.week') : t('band.title');
  const lanes = [canReadMonitors, canReadTargets, canReadDeployments].filter(Boolean).length;
  if (lanes === 0) {
    return (
      <Panel title={title}>
        <PanelEmpty>{t('band.locked')}</PanelEmpty>
      </Panel>
    );
  }

  const monitorSamples = pulse?.coverage.samples ?? 0;
  const monitorHealthy = pulse?.points.reduce((sum, point) => sum + point.healthy, 0) ?? 0;
  const latencyMedian = median(pulse?.points.map((point) => point.latencyAvgMs) ?? []);
  const fleetPeak = fleet ? Math.max(0, ...fleet.points.map((point) => point.loadPercent ?? 0)) : 0;
  const loadLimit = HOST_METRIC_CATALOG.load.defaultLimitPercent;

  return (
    <section className="card min-w-0 overflow-hidden">
      <div className="card-h flex-wrap">
        <h2>{title}</h2>
        <span className="t-cap ml-auto text-text-3">
          {windowKey === 'week' ? t('band.aside.week') : t('band.aside')}
        </span>
      </div>

      <ReadoutBar bare>
        {canReadMonitors ? (
          <Readout
            label={t('band.availability')}
            value={
              monitorSamples === 0
                ? '—'
                : monitorSamples < RATE_FLOOR
                  ? monitorHealthy
                  : ((monitorHealthy / monitorSamples) * 100)
                      .toFixed(1)
                      .replace('.', t('band.decimal'))
            }
            unit={
              monitorSamples === 0
                ? undefined
                : monitorSamples < RATE_FLOOR
                  ? `/ ${monitorSamples}`
                  : '%'
            }
            /*
              Green only when green means something: under the measurements floor,
              the indicator stays off. Amber, for its part, is due as soon as a
              measurement failed — an observed fault is a fact.
            */
            tone={
              monitorSamples === 0
                ? 'idle'
                : monitorHealthy < monitorSamples
                  ? 'warn'
                  : monitorSamples < RATE_FLOOR
                    ? 'idle'
                    : 'ok'
            }
            hint={
              monitorSamples === 0
                ? t('band.availability.none')
                : monitorSamples < RATE_FLOOR
                  ? t('band.availability.thin')
                  : t('band.availability.over', { count: formatNumber(monitorSamples, format) })
            }
          />
        ) : null}
        {canReadMonitors ? (
          <Readout
            label={t('band.latency')}
            value={latencyMedian === null ? '—' : Math.round(latencyMedian)}
            unit={latencyMedian === null ? undefined : 'ms'}
            tone="idle"
            hint={latencyMedian === null ? t('band.latency.none') : t('band.latency.over')}
          />
        ) : null}
        {canReadTargets ? (
          <Readout
            label={t('band.load')}
            value={fleet === null || fleet.coverage.samples === 0 ? '—' : Math.round(fleetPeak)}
            unit={fleet === null || fleet.coverage.samples === 0 ? undefined : '%'}
            tone={
              fleet === null || fleet.coverage.samples === 0
                ? 'idle'
                : fleetPeak >= loadLimit
                  ? 'danger'
                  : fleetPeak >= loadLimit * 0.7
                    ? 'warn'
                    : fleet.coverage.samples < RATE_FLOOR
                      ? 'idle'
                      : 'ok'
            }
            hint={
              fleet === null || fleet.coverage.samples === 0
                ? t('band.load.none')
                : t('band.load.over', {
                    covered: fleet.coverage.covered,
                    buckets: fleet.coverage.buckets,
                  })
            }
          />
        ) : null}
        {canReadAudit ? (
          <Readout
            label={t('band.denied')}
            value={activity === null ? '—' : activity.denied}
            tone={activity === null ? 'idle' : activity.denied > 0 ? 'danger' : 'ok'}
            hint={
              activity === null
                ? ''
                : t('band.denied.over', { count: formatNumber(activity.total, format) })
            }
          />
        ) : null}
      </ReadoutBar>

      {canReadMonitors && pulse ? (
        <Track
          title={t('lane.monitor.title')}
          aside={
            pulse.monitorsSeen > 0
              ? t('lane.monitor.aside.active', { count: pulse.monitorsSeen })
              : t('lane.monitor.aside')
          }
          href="/monitors"
        >
          <MonitorLane pulse={pulse} format={format} />
        </Track>
      ) : null}

      {canReadMonitors && pulse ? (
        <Track title={t('lane.latency.title')} aside={t('lane.latency.aside')} href="/monitors">
          <LatencyLane pulse={pulse} format={format} />
        </Track>
      ) : null}

      {canReadTargets && fleet ? (
        <Track
          title={t('lane.fleet.title')}
          aside={t('lane.fleet.aside', { limit: loadLimit })}
          href="/apps"
        >
          <FleetLane fleet={fleet} limit={loadLimit} format={format} />
        </Track>
      ) : null}

      {canReadDeployments && chronicle ? (
        <Track
          title={t('lane.chronicle.title')}
          aside={chronicleAside(chronicle, posture, window, t)}
          href="/deployments"
        >
          <ChronicleLane chronicle={chronicle} window={window} />
        </Track>
      ) : null}

      <div className="flex items-center gap-6 px-[18px] pt-2 pb-3.5">
        <div className="w-[190px] shrink-0 max-md:hidden" />
        <div className="min-w-0 flex-1">
          <TimeAxis from={window.from} to={window.to} />
        </div>
      </div>
    </section>
  );
}

/**
 * A track: its name (which leads to the detailed screen) and what it measures, in
 * a 190 px column, then the figure. All the tracks share this column: it is what
 * aligns the figures on the axis.
 */
function Track({
  title,
  aside,
  href,
  children,
}: {
  title: string;
  aside?: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-6 border-t border-border-subtle px-[18px] py-3 max-md:flex-col max-md:items-stretch max-md:gap-2">
      <div className="flex w-[190px] shrink-0 flex-col gap-0.5 max-md:w-auto">
        <Link href={href as never} className="t-sm font-semibold text-text hover:underline">
          {title}
        </Link>
        {aside ? <span className="t-cap text-text-3">{aside}</span> : null}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

async function MonitorLane({ pulse, format }: { pulse: MonitorPulse; format: FormatSettings }) {
  const t = await getT(dashboard);
  const bars = pulse.points.map((point) => ({
    at: point.at,
    samples: point.samples,
    hits: point.healthy,
  }));
  if (densityOf(bars).verdict === 'none') {
    return (
      <NotEnoughHistory
        covered={0}
        buckets={pulse.coverage.buckets}
        nothing={t('lane.monitor.nothing')}
        since={pulse.coverage.firstAt}
        format={format}
      >
        <p className="t-cap text-text-3">
          {t('lane.monitor.help')}{' '}
          <Link href="/monitors" className="link">
            {t('link.monitors')}
          </Link>
          .
        </p>
      </NotEnoughHistory>
    );
  }
  return (
    <RatioBars
      buckets={bars}
      label={t('lane.monitor.title')}
      unit={t('lane.monitor.unit')}
      format={format}
    />
  );
}

/**
 * The measured latency, bucket by bucket. A probe can stay "healthy" while
 * becoming twice as slow: it is the degradation a dashboard of the instant does
 * not show. The ceiling is rounded up to the next quarter second, so that the
 * scale compares from one day to the next.
 */
async function LatencyLane({ pulse, format }: { pulse: MonitorPulse; format: FormatSettings }) {
  const t = await getT(dashboard);
  const series = pulse.points.map((point) => ({
    at: point.at,
    // Without a recorded latency, the bucket is empty: an unreachable probe did not
    // "take 0 ms", it measured nothing at all.
    samples: point.latencyAvgMs === null ? 0 : point.samples,
    value: point.latencyAvgMs,
  }));
  if (densityOf(series).verdict === 'none') {
    return (
      <NotEnoughHistory
        covered={0}
        buckets={pulse.coverage.buckets}
        nothing={t('lane.latency.nothing')}
        since={pulse.coverage.firstAt}
        format={format}
      />
    );
  }
  const peak = Math.max(...series.map((bucket) => bucket.value ?? 0));
  return (
    <SeriesLine
      buckets={series}
      label={t('lane.latency.title')}
      max={Math.max(50, Math.ceil(peak / 25) * 25)}
      unit=" ms"
      format={format}
    />
  );
}

async function FleetLane({
  fleet,
  limit,
  format,
}: {
  fleet: FleetPulse;
  limit: number;
  format: FormatSettings;
}) {
  const t = await getT(dashboard);
  const series = fleet.points.map((point) => ({
    at: point.at,
    samples: point.samples,
    value: point.loadPercent,
  }));
  const density = densityOf(series);
  if (density.verdict === 'none') {
    return (
      <NotEnoughHistory
        covered={0}
        buckets={fleet.coverage.buckets}
        nothing={t('lane.fleet.nothing')}
        since={fleet.coverage.firstAt}
        format={format}
      >
        <p className="t-cap text-text-3">{t('lane.fleet.help')}</p>
      </NotEnoughHistory>
    );
  }
  return (
    <>
      <SeriesLine
        buckets={series}
        label={t('lane.fleet.series')}
        max={Math.max(100, ...series.map((bucket) => bucket.value ?? 0))}
        unit="%"
        tone="var(--gauge-fill)"
        threshold={limit}
        format={format}
      />
      {density.verdict === 'sparse' ? (
        <p className="t-cap mt-1 text-warn-text">{t('lane.fleet.sparse')}</p>
      ) : null}
    </>
  );
}

/** "7 runs in the window · median duration 81 s". */
function chronicleAside(
  chronicle: DeploymentPulse,
  posture: ScanPosture | null,
  window: ReturnType<typeof pulseWindow>,
  t: T,
): string {
  const start = Date.parse(window.from);
  const inWindow = chronicle.events.filter((event) => Date.parse(event.at) >= start).length;
  const older = chronicle.events.length - inWindow;
  return (
    t('chronicle.inWindow', { count: inWindow }) +
    (older > 0 ? t('chronicle.offAxis', { count: older }) : '') +
    (chronicle.medianDurationSeconds === null
      ? t('chronicle.median.none')
      : t('chronicle.median.value', { seconds: chronicle.medianDurationSeconds })) +
    (posture && posture.runs > 0 ? t('chronicle.scans', { count: posture.runs }) : '')
  );
}

/**
 * The window's events, placed at their exact instant. The oldest ones of the
 * chronicle are counted in the track's subtitle, but are not drawn off the axis:
 * a point squeezed against the left edge would be a made-up position.
 */
async function ChronicleLane({
  chronicle,
  window,
}: {
  chronicle: DeploymentPulse;
  window: ReturnType<typeof pulseWindow>;
}) {
  const t = await getT(dashboard);
  const start = Date.parse(window.from);
  const inWindow = chronicle.events.filter((event) => Date.parse(event.at) >= start);
  const older = chronicle.events.length - inWindow.length;

  const events: TimelineEvent[] = inWindow.map((event) => ({
    key: event.id,
    at: event.at,
    tone: DEPLOYMENT_TONE[event.status] ?? 'idle',
    title:
      t('chronicle.event', {
        app: event.applicationSlug,
        version: event.version,
        target: event.targetName,
        status: labelOf(STATUS_KEY, event.status, t),
      }) +
      (event.durationSeconds === null ? '' : ` · ${event.durationSeconds} s`) +
      (event.failedStep ? t('chronicle.event.step', { step: event.failedStep }) : ''),
  }));

  if (events.length === 0) {
    return (
      <div className="rounded-[10px] border border-dashed border-border-strong bg-surface-2 px-3.5 py-2.5">
        <p className="t-sm">{t('chronicle.empty')}</p>
        <p className="t-cap text-text-3">
          {older === 0
            ? t('chronicle.empty.none', { days: CHRONICLE_DAYS })
            : t('chronicle.empty.older', { count: older, days: CHRONICLE_DAYS })}
        </p>
      </div>
    );
  }

  return (
    <EventRail
      events={events}
      from={window.from}
      to={window.to}
      label={t('lane.chronicle.title')}
    />
  );
}

// ─── le parc ──────────────────────────────────────────────────────────────────

/**
 * One row per machine: its state, the shape of its load over the window, what it
 * carries, its runtime, its memory and its disk. The micro-curve carries no scale
 * — it is only asked to show whether things go up. A machine without a reading
 * says so in words instead of showing a flat curve at zero, which would read
 * "idle machine".
 */
async function FleetPanel({
  targets,
  histories,
  running,
  windowKey,
}: {
  targets: readonly PublicTarget[];
  histories: Map<string, TargetHistory>;
  running: readonly SupervisedApp[];
  windowKey: WindowKey;
}) {
  const t = await getT(dashboard);
  const windowLabel = windowKey === 'week' ? t('fleet.window.week') : t('fleet.window.day');

  if (targets.length === 0) {
    return (
      <Panel title={t('fleet.title')} href="/targets" linkLabel={t('link.targets')}>
        <PanelEmpty>
          {t('fleet.empty')}{' '}
          <Link href="/targets" className="link">
            {t('link.targets')}
          </Link>
          .
        </PanelEmpty>
      </Panel>
    );
  }

  const load = HOST_METRIC_CATALOG.load.defaultLimitPercent;
  const memory = HOST_METRIC_CATALOG.memory.defaultLimitPercent;
  const disk = HOST_METRIC_CATALOG.disk.defaultLimitPercent;
  const appsOn = new Map<string, number>();
  for (const app of running) appsOn.set(app.targetId, (appsOn.get(app.targetId) ?? 0) + 1);

  return (
    <Panel
      title={t('fleet.title')}
      aside={t('fleet.aside', { count: targets.length, window: windowLabel })}
      href="/apps"
      linkLabel={t('link.servers')}
    >
      <ul className="list">
        {targets.map((target) => {
          const history = histories.get(target.id);
          const summary = history?.summary;
          const measured = (history?.samples ?? 0) > 0;
          const apps = appsOn.get(target.id) ?? 0;
          const runtimes = target.runtimesAvailable;
          const hot = (summary?.load.worst ?? 0) >= load || target.status === 'degraded';

          return (
            <li key={target.id} className="flex-wrap gap-y-1 py-2.5">
              <Led tone={TARGET_TONE[target.status]} label={target.status} />
              <span className="flex w-[150px] min-w-0 flex-col">
                <Link
                  href={`/targets?target=${target.id}`}
                  className="mono truncate text-[12.5px] font-semibold text-text hover:underline"
                >
                  {target.name}
                </Link>
                <span className="mono truncate text-[11px] text-text-3">{target.host}</span>
              </span>
              <span className="w-[260px] max-lg:hidden">
                {measured ? (
                  <MicroSpark
                    values={(history?.points ?? []).map((point) => point.loadPercent)}
                    width={240}
                    height={22}
                    max={100}
                    tone={hot ? 'var(--warn)' : 'var(--gauge-fill)'}
                  />
                ) : (
                  <span className="t-cap text-text-3">{t('fleet.noReadout')}</span>
                )}
              </span>
              <span className="t-cap w-[120px] text-text-3 max-md:hidden">
                {apps > 0 ? t('fleet.apps', { count: apps }) : t('fleet.apps.none')}
              </span>
              <span className="t-cap flex items-center gap-1.5 text-text-3 max-md:hidden">
                {runtimes.docker.available ? (
                  <RuntimePill name="Docker" version={runtimes.docker.version} available />
                ) : null}
                {runtimes.k3s.available ? (
                  <RuntimePill name="K3s" version={runtimes.k3s.version} available />
                ) : null}
                {!runtimes.docker.available && !runtimes.k3s.available
                  ? t('fleet.runtime.unknown')
                  : null}
              </span>
              {measured ? (
                <span className="ml-auto flex items-center gap-3">
                  <MiniGauge
                    label={t('fleet.gauge.memory')}
                    value={summary?.memory.last ?? null}
                    warn={(summary?.memory.last ?? 0) >= memory}
                  />
                  <MiniGauge
                    label={t('fleet.gauge.disk')}
                    value={summary?.disk.last ?? null}
                    warn={(summary?.disk.last ?? 0) >= disk}
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

// ─── the deployments ──────────────────────────────────────────────────────────

/**
 * The last deployments, with their duration. The bar is relative to the longest
 * of the list: what one looks for out of the corner of the eye is "that one took
 * three times longer than the others"; the figure is next to it.
 */
async function DeploymentsPanel({
  recent,
  chronicle,
}: {
  recent: readonly DeploymentSummary[];
  chronicle: DeploymentPulse | null;
}) {
  const t = await getT(dashboard);
  // A step's name is rendered from its key, in the current language.
  const language = await currentLanguage();
  const durations = new Map(
    (chronicle?.events ?? []).map((event) => [event.id, event.durationSeconds]),
  );
  const longest = Math.max(1, ...[...durations.values()].map((value) => value ?? 0));
  const weakness = chronicle?.weaknesses[0];

  return (
    <Panel
      title={t('deployments.title')}
      href="/deployments"
      linkLabel={t('link.history')}
      footer={
        weakness ? (
          <>
            <Info aria-hidden className="!size-3.5 shrink-0" />
            <span>
              {t('deployments.weakness', { days: CHRONICLE_DAYS })}{' '}
              {t('deployments.weakness.name', {
                name: deploymentStepLabel(weakness.key, language, weakness.label),
              })}{' '}
              {t('deployments.weakness.count', {
                count: weakness.failed,
                failed: weakness.failed,
                decided: weakness.decided,
              })}
              .
            </span>
          </>
        ) : undefined
      }
    >
      {recent.length === 0 ? (
        <PanelEmpty>{t('deployments.empty')}</PanelEmpty>
      ) : (
        <ul className="list">
          {recent.map((item) => {
            const seconds = durations.get(item.id) ?? null;
            return (
              <li key={item.id} className="flex-wrap gap-y-1">
                <Link
                  href={`/deployments?run=${item.id}`}
                  className="mono w-[190px] min-w-0 truncate text-[12.5px] text-text hover:underline max-sm:flex-1"
                >
                  {item.applicationSlug} <span className="text-text-3">v{item.version}</span>
                </Link>
                <span className="flex w-[110px] items-center gap-2 max-sm:hidden">
                  <i
                    aria-hidden
                    className="relative block h-1 w-10 overflow-hidden rounded-sm bg-surface-3"
                  >
                    {seconds === null ? null : (
                      <b
                        className="absolute inset-y-0 left-0 bg-idle"
                        style={{ width: `${Math.max(6, (seconds / longest) * 100)}%` }}
                      />
                    )}
                  </i>
                  <span className="t-cap num text-text-3">
                    {seconds === null ? '—' : duration(seconds, t)}
                  </span>
                </span>
                <DeploymentStatusBadge status={item.status} />
                <span className="t-cap ml-auto shrink-0 whitespace-nowrap text-text-3">
                  {since(item.finishedAt ?? item.createdAt, t) ?? ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/**
 * The line under the targets counter — it must explain the gap, not comment on
 * it.
 */
function targetsHint(
  { targetsDown, targetsUntested }: { targetsDown: number; targetsUntested: number },
  t: T,
): string {
  const parts: string[] = [];
  if (targetsDown > 0) parts.push(t('readout.targets.faulty', { count: targetsDown }));
  if (targetsUntested > 0) parts.push(t('readout.targets.untested', { count: targetsUntested }));
  return parts.length > 0 ? parts.join(', ') : t('readout.targets.ok');
}
