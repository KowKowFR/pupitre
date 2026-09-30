import Link from 'next/link';
import { Info } from 'lucide-react';
import { deploymentStepLabel, type Translate } from '@pupitre/core';
import {
  activityPulse,
  foldFleet,
  getAppSettings,
  HOST_METRIC_CATALOG,
  monitorPulse,
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
import { Led, Readout, ReadoutBar, type Tone } from '@/components/instrument';
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
import { AttentionPanel, Panel, PanelEmpty } from './attention';
import { DeploymentStatusBadge } from './deployments/status-badge';

export const dynamic = 'force-dynamic';

/**
 * La vue d'ensemble. Trois questions, dans cet ordre, et l'écran ne répond à
 * rien d'autre :
 *
 *   1. **Faut-il intervenir ?** — le bloc d'attention, en tête.
 *   2. **Que s'est-il passé ?** — la fenêtre (24 h ou 7 jours) : quatre
 *      relevés, puis quatre pistes sur un axe partagé.
 *   3. **Dans quel état est le parc ?** — les machines, ce qui tourne, les
 *      derniers déploiements, puis l'inventaire qui ferme l'écran.
 *
 * Tout ce qu'une permission interdit disparaît : une piste, une carte, un
 * bouton. Rien n'est grisé.
 */

/** Les deux fenêtres d'observation : 24 seaux d'une heure, ou 28 de six heures. */
const WINDOWS = {
  day: { hours: 24, buckets: 24 },
  week: { hours: 168, buckets: 28 },
} as const;

type WindowKey = keyof typeof WINDOWS;

/** Plancher sous lequel un taux n'est qu'un décompte : 20 mesures. */
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

/** « il y a 3 min ». Rend `null` plutôt qu'un tiret : l'appelant décide. */
function since(date: Date | null, t: T): string | null {
  if (!date) return null;
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return t('since.seconds', { count: seconds });
  if (seconds < 3600) return t('since.minutes', { count: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t('since.hours', { count: Math.floor(seconds / 3600) });
  return t('since.days', { count: Math.floor(seconds / 86_400) });
}

/** « 74 s », « 1 min 52 s ». */
function duration(seconds: number, t: T): string {
  if (seconds < 90) return t('duration.seconds', { seconds });
  return t('duration.minutes', {
    minutes: Math.floor(seconds / 60),
    seconds: String(seconds % 60).padStart(2, '0'),
  });
}

/** Médiane d'une série éparse. `null` sous trois valeurs — deux n'en ont pas. */
function median(values: readonly (number | null)[]): number | null {
  const clean = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (clean.length < 3) return null;
  return clean[Math.floor(clean.length / 2)] ?? null;
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await currentAuth('/');
  const t = await getT(dashboard);
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

  // Les cibles d'abord : leurs identifiants conditionnent l'historique du parc.
  const targets = canReadTargets ? await loadTargets() : ([] as PublicTarget[]);

  // Le formatage descend par props jusqu'aux figures : la locale d'instance
  // décide de « 00:33 » comme de « 12 345 », partout sur l'écran.
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
  // Une cible jamais testée n'est pas une cible en panne : c'est une
  // installation qu'on n'a pas finie. Les confondre faisait dire deux choses
  // contraires au même écran.
  const targetsUntested = targets.filter((target) => target.status === 'unknown').length;
  const targetsDown = targets.length - targetsUp - targetsUntested;
  const monitorsUp = monitors.filter((monitor) => monitor.status === 'healthy').length;
  const appsHealthy = running.filter((app) => app.healthStatus === 'healthy').length;

  const attention = collectAttention({ targets, running, monitors, recent, chronicle, posture, t });

  return (
    <>
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

      <AttentionPanel items={attention} />

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
        `items-start` : ces deux blocs n'ont aucune raison d'avoir la même
        hauteur. Étirés, une liste d'une ligne se retrouvait au milieu d'un
        grand vide.
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
                      href={`/apps/${app.id}`}
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
        L'inventaire ferme l'écran au lieu de l'ouvrir : ces chiffres rassurent,
        ils ne déclenchent rien.
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

// ─── la fenêtre ───────────────────────────────────────────────────────────────

/**
 * La fenêtre d'observation, sur un axe unique.
 *
 * Les pistes partagent exactement les mêmes bornes de seau — c'est garanti par
 * `pulseWindow`, dont l'alignement est le même que celui de `targetHistories`.
 * C'est ce qui permet de lire verticalement : le déploiement de 00 h 33 tombe
 * au-dessus du creux de charge de 00 h 33.
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
              Vert seulement quand le vert veut dire quelque chose : sous le
              plancher de mesures, le voyant reste éteint. L'ambre, lui, reste
              dû dès qu'une mesure a échoué — un défaut constaté est un fait.
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
 * Une piste : son nom (qui mène à l'écran détaillé) et ce qu'elle mesure, dans
 * une colonne de 190 px, puis la figure. Toutes les pistes partagent cette
 * colonne : c'est ce qui aligne les figures sur l'axe.
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
 * La latence mesurée, seau par seau. Une sonde peut rester « saine » en
 * devenant deux fois plus lente : c'est la dégradation qu'un tableau de bord
 * de l'instant ne montre pas. Le plafond est arrondi au quart de seconde
 * supérieur, pour que l'échelle se compare d'un jour sur l'autre.
 */
async function LatencyLane({ pulse, format }: { pulse: MonitorPulse; format: FormatSettings }) {
  const t = await getT(dashboard);
  const series = pulse.points.map((point) => ({
    at: point.at,
    // Sans latence relevée, le seau est vide : une sonde injoignable n'a pas
    // « mis 0 ms », elle n'a rien mesuré du tout.
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

/** « 7 runs dans la fenêtre · durée médiane 81 s ». */
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
 * Les événements de la fenêtre, posés à leur instant exact. Les plus anciens
 * de la chronique sont comptés dans le sous-titre de la piste, mais ne sont
 * pas dessinés hors de l'axe : un point tassé contre le bord gauche serait une
 * position inventée.
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
 * Une ligne par machine : son état, la forme de sa charge sur la fenêtre, ce
 * qu'elle porte, son runtime, sa mémoire et son disque. La micro-courbe ne
 * porte pas d'échelle — on ne lui demande que de montrer si ça monte. Une
 * machine sans relevé le dit en toutes lettres au lieu d'afficher une courbe
 * plate à zéro, qui se lirait « machine au repos ».
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
                  href={`/targets/${target.id}`}
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

// ─── les déploiements ─────────────────────────────────────────────────────────

/**
 * Les derniers déploiements, avec leur durée. La barre est relative au plus
 * long de la liste : ce qu'on cherche du coin de l'œil, c'est « celui-là a
 * pris trois fois plus de temps que les autres » ; le chiffre est à côté.
 */
async function DeploymentsPanel({
  recent,
  chronicle,
}: {
  recent: readonly DeploymentSummary[];
  chronicle: DeploymentPulse | null;
}) {
  const t = await getT(dashboard);
  // Le nom d'une étape se rend à partir de sa clé, dans la langue courante.
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
                  href={`/deployments/${item.id}`}
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
 * La ligne sous le compteur de cibles — elle doit expliquer l'écart, pas le
 * commenter.
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
