import 'server-only';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { isSupervisable, parseAppSpec, type Translate } from '@pupitre/core';
import {
  getAppSettings,
  getDeploymentForRun,
  getDeploymentSummary,
  listChecks,
  listMonitors,
  listSupervisedApps,
  openIncidentFor,
  resolveThresholds,
  scanDigestForDeployments,
  targetHistories,
  uptimeWindows,
} from '@pupitre/db';
import { MiniGauge, MicroSpark } from '@/components/chart';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldValue } from '@/components/ui/data';
import { getT } from '@/i18n/server';
import { common } from '@/i18n/messages/common';
import { appConsole } from '@/i18n/messages/console';
import { servers } from '@/i18n/messages/servers';
import {
  createDateFormatter,
  formatDateTimeWith,
  formatNumber,
  formatSettingsOf,
  type FormatSettings,
} from '@/lib/format';
import type { AuthContext } from '@/lib/rbac';
import { relativeTime } from '@/lib/relative-time';
import { withSlot } from '@/lib/rich';
import { HealthDot, type HealthStatus } from '../apps-table';
import { AppActions } from './app-actions';
import { AppConsole, type ConsoleApp, type ConsoleService } from './app-console';

/**
 * The machine readings window rendered with the record. The same framing as the
 * per-server monitoring screen — 24 h in 48 intervals — so that a strip read here
 * and a strip read there mean the same thing.
 */
const HISTORY_HOURS = 24;
const HISTORY_BUCKETS = 48;

/** The probe's last passes, as a band: enough to see an outage that lasts. */
const MONITOR_STRIP = 36;

type T = Translate<typeof appConsole.fr>;

export type RunningAppRecord = {
  /** The identifier of the deployment in service: it is the drawer's key. */
  key: string;
  header: {
    applicationSlug: string;
    targetName: string;
    url: string | null;
    restored: boolean;
    health: HealthStatus | null;
  };
  /** The gestures on the application (redeploy, go back, destroy…); `null` once it stopped. */
  actions: ReactNode;
  body: ReactNode;
};

/**
 * A running application, rendered on the server for its drawer.
 *
 * It is opened when something goes wrong, often at an ungodly hour, and it must
 * answer four questions in this order: **does it run**, **since when and in what
 * state**, **what does it say**, **what does it consume**.
 *
 * Two sources, never mixed:
 *
 *   - the **database** says what one wanted to set (version, AppSpec, author,
 *     date, scan, thresholds). It always answers, machine off included, and it is
 *     rendered here;
 *   - the **machine** says what runs *right now*. That only comes through the
 *     stream, in `AppConsole`, and its absence is spelled out — it does not
 *     disguise itself as "no container".
 */
export async function runningAppRecord(
  id: string,
  auth: AuthContext,
): Promise<RunningAppRecord | null> {
  const deployment = await getDeploymentSummary(id);
  if (!deployment) return null;

  const t = await getT(appConsole);

  if (!isSupervisable(deployment.status)) {
    return {
      key: deployment.id,
      header: {
        applicationSlug: deployment.applicationSlug,
        targetName: deployment.targetName,
        url: null,
        restored: false,
        health: null,
      },
      actions: null,
      body: (
        <Alert variant="destructive">
          {withSlot(
            (link) => t('gone.alert', { status: deployment.status, link }),
            <Link href={`/deployments?run=${deployment.id}`} className="link">
              {t('gone.link')}
            </Link>,
          )}
        </Alert>
      ),
    };
  }

  const canReadTargets = auth.can('target:read');
  const canReadScans = auth.can('scan:read');
  const canReadMonitors = auth.can('monitor:read');

  // `listSupervisedApps` carries the health and the possible update failure; we
  // read this application there rather than rebuild the information by hand.
  const [supervisedAll, run, { settings }, scanDigests, monitors, tCommon, tServers] =
    await Promise.all([
      listSupervisedApps(),
      // A single query for the deployment's frozen AppSpec *and* its steps.
      getDeploymentForRun(deployment.id),
      getAppSettings(),
      canReadScans ? scanDigestForDeployments([deployment.id]) : Promise.resolve(null),
      canReadMonitors ? listMonitors() : Promise.resolve([]),
      getT(common),
      getT(servers),
    ]);

  const supervised = supervisedAll.find((app) => app.id === deployment.id);
  const format = formatSettingsOf(settings);
  const formatDate = createDateFormatter(format);

  /**
   * The AppSpec **frozen in the deployment**, not the application's.
   *
   * It is what is really set on the machine. Reading the application's current
   * spec would give the next version's inventory, not the running one's — exactly
   * the mistake a monitoring screen must not make.
   */
  const spec = run ? parseAppSpec(run.deployment.appSpec) : null;
  const specVersion = spec?.version ?? null;

  const services: ConsoleService[] = (spec?.services ?? []).map((service) => ({
    name: service.name,
    // For an image pulled from a registry, the spec names it. For an image built on
    // the target, only the runtime knows its final name: we do not guess it here,
    // the reading will say it.
    image: service.source.type === 'image' ? service.source.ref : null,
    built: service.source.type === 'dockerfile',
    port: service.port,
    exposed: service.exposed,
    dependsOn: [...service.dependsOn],
    replicas: service.replicas,
    cpuMilli: service.resources?.cpuMilli ?? null,
    memoryMi: service.resources?.memoryMi ?? null,
    probePath: service.healthcheck.path,
    probeIntervalSec: service.healthcheck.intervalSec,
    probeRetries: service.healthcheck.retries,
  }));

  // This application's site probe, if there is one. The link is carried by the
  // application, never by the deployment: a probe survives the versions.
  const monitor = monitors.find((row) => row.applicationId === deployment.applicationId) ?? null;
  const [uptime, checks, incident] = monitor
    ? await Promise.all([
        uptimeWindows([monitor.id], 24).then((windows) => windows.get(monitor.id) ?? null),
        listChecks(monitor.id, MONITOR_STRIP),
        openIncidentFor(monitor.id),
      ])
    : [null, [], null];

  // The machine's past comes from the database, not from the machine: it shows
  // even when the machine no longer answers, which is precisely when one looks at
  // it.
  const [histories, thresholds] = canReadTargets
    ? await Promise.all([
        targetHistories([deployment.targetId], HISTORY_HOURS, HISTORY_BUCKETS),
        resolveThresholds(deployment.targetId),
      ])
    : [null, null];
  const history = histories?.get(deployment.targetId) ?? null;

  const scan = scanDigests?.get(deployment.id) ?? null;
  const steps = run?.steps ?? [];
  const failedStep = steps.find((step) => step.status === 'failed') ?? null;
  const onlineSince = deployment.finishedAt ?? deployment.createdAt;

  const view: ConsoleApp = {
    id: deployment.id,
    applicationSlug: deployment.applicationSlug,
    targetName: deployment.targetName,
    targetHost: deployment.targetHost,
    runtime: deployment.runtime,
    version: deployment.version,
    healthStatus: supervised?.healthStatus ?? 'unknown',
    lastHealthAt: supervised?.lastHealthAt?.toISOString() ?? null,
    services,
  };

  const over = (value: number | null, limit: number | undefined) =>
    value !== null && value >= (limit ?? 100);

  return {
    key: deployment.id,
    header: {
      applicationSlug: deployment.applicationSlug,
      targetName: deployment.targetName,
      url: deployment.url,
      restored: deployment.status === 'rolled_back',
      health: supervised?.healthStatus ?? 'unknown',
    },
    actions: (
      <AppActions
        deploymentId={deployment.id}
        applicationId={deployment.applicationId}
        applicationSlug={deployment.applicationSlug}
        targetName={deployment.targetName}
        runtime={deployment.runtime}
        specVersion={specVersion}
        format={format}
        canDeploy={auth.can('deployment:create')}
        canDestroy={auth.can('deployment:destroy')}
      />
    ),
    body: (
      <>
        {/* The displayed version is not necessarily the last one that was meant to be set. */}
        {supervised?.lastFailedUpdate ? (
          <Alert variant="warn">
            {t('failedUpdate.text', {
              number: supervised.lastFailedUpdate.number,
              step: supervised.lastFailedUpdate.failedStep
                ? t('failedUpdate.step', { step: supervised.lastFailedUpdate.failedStep })
                : '',
              current: specVersion ?? `#${deployment.number}`,
            })}{' '}
            <Link
              href={`/deployments?run=${supervised.lastFailedUpdate.deploymentId}`}
              className="link"
            >
              {t('failedUpdate.link')}
            </Link>
          </Alert>
        ) : null}

        <AppConsole
          key={deployment.id}
          app={view}
          /*
            Rendered on the server side and slipped into the left column: they are
            SQL reads, they have no reason to cross the browser nor to wait for
            the stream to open.
          */
          context={
            <>
              <Card>
                <CardHeader
                  actions={
                    <Link href={`/deployments?run=${deployment.id}`} className="link t-cap">
                      {t('rollout.trace')}
                    </Link>
                  }
                >
                  <CardTitle>{t('rollout.title')}</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-x-6 gap-y-4">
                  <FieldValue label={t('rollout.version')}>
                    <span className="mono">
                      #{deployment.number}
                      {specVersion ? ` · ${t('rollout.spec', { version: specVersion })}` : ''}
                    </span>
                  </FieldValue>
                  <FieldValue label={t('rollout.runtime')}>
                    {t(`runtime.${deployment.runtime}`)}
                  </FieldValue>
                  <FieldValue label={t('rollout.at')}>
                    <span className="flex flex-col">
                      <span className="mono">{formatDate(onlineSince)}</span>
                      <span className="t-cap text-text-3">
                        {relativeTime(onlineSince, tCommon)}
                      </span>
                    </span>
                  </FieldValue>
                  <FieldValue label={t('rollout.duration')}>
                    {deployDuration(deployment.startedAt, deployment.finishedAt, t)}
                  </FieldValue>
                  <FieldValue label={t('rollout.by')}>
                    <span className="mono t-cap break-all">
                      {deployment.triggeredByEmail ?? t('rollout.byUnknown')}
                    </span>
                  </FieldValue>
                  {/*
                                     The scan belongs to this release, not to the present
                                     instant: it ran on this version's images, once. It is
                                     therefore a field of the release, next to its date, and
                                     not a separate watch.
                                   */}
                  <FieldValue label={t('rollout.scan')}>
                    <ScanSummary canRead={canReadScans} scan={scan} t={t} />
                  </FieldValue>
                  {failedStep ? (
                    <div className="col-span-2">
                      <FieldValue label={t('rollout.failedStep')}>
                        <span className="text-danger-text">{failedStep.label}</span>
                      </FieldValue>
                    </div>
                  ) : null}
                </CardContent>
              </Card>

              <Card>
                <CardHeader
                  actions={
                    canReadTargets ? (
                      <Link
                        href={`/targets?target=${deployment.targetId}`}
                        className="link mono t-cap"
                      >
                        {deployment.targetName}
                      </Link>
                    ) : (
                      <span className="mono t-cap text-text-3">{deployment.targetName}</span>
                    )
                  }
                >
                  <CardTitle>{t('machine.title')}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2.5">
                  {!canReadTargets ? (
                    <p className="t-sm text-text-3">{t('machine.restricted')}</p>
                  ) : history && history.samples > 0 ? (
                    <>
                      <span
                        role="img"
                        aria-label={t('machine.spark', { hours: HISTORY_HOURS })}
                        className="block"
                      >
                        <MicroSpark
                          values={history.points.map((point) => point.loadPercent)}
                          max={Math.max(
                            thresholds?.load.limitPercent ?? 100,
                            history.summary.load.worst ?? 0,
                          )}
                          width={300}
                          height={36}
                          className="h-9 w-full"
                        />
                      </span>
                      <div className="flex flex-wrap items-center gap-3">
                        <MiniGauge
                          label={t('gauge.load')}
                          value={history.summary.load.last}
                          warn={over(history.summary.load.last, thresholds?.load.limitPercent)}
                        />
                        <MiniGauge
                          label={t('gauge.memory')}
                          value={history.summary.memory.last}
                          warn={over(history.summary.memory.last, thresholds?.memory.limitPercent)}
                        />
                        <MiniGauge
                          label={t('gauge.disk')}
                          value={history.summary.disk.last}
                          warn={over(history.summary.disk.last, thresholds?.disk.limitPercent)}
                        />
                      </div>
                      <p className="t-cap text-text-3">
                        {t('machine.caption', { hours: HISTORY_HOURS })}
                      </p>
                    </>
                  ) : (
                    <p className="t-sm text-text-3">
                      {t('machine.empty', { hours: HISTORY_HOURS })}
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader
                  actions={
                    monitor ? (
                      <Link href={`/monitors?monitor=${monitor.id}`} className="link t-cap">
                        {monitor.name}
                      </Link>
                    ) : null
                  }
                >
                  <CardTitle>{t('monitor.title')}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {!canReadMonitors ? (
                    <p className="t-sm text-text-3">{t('monitor.restricted')}</p>
                  ) : !monitor ? (
                    <p className="t-sm text-text-3">
                      {t('monitor.none')}{' '}
                      <Link href="/monitors" className="link">
                        {t('monitor.create')}
                      </Link>
                    </p>
                  ) : (
                    <>
                      <HealthDot
                        health={monitor.status}
                        meta={
                          incident
                            ? t('monitor.since', { age: shortAge(incident.startedAt, tServers) })
                            : undefined
                        }
                      />
                      {checks.length > 0 ? (
                        <div
                          className="strip"
                          style={{ height: 14 }}
                          role="img"
                          aria-label={t('monitor.strip', { count: checks.length })}
                        >
                          {[...checks].reverse().map((check) => (
                            <i
                              key={check.id}
                              className={STRIP_CLASS[check.outcome]}
                              title={formatDateTimeWith(check.checkedAt, format, {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            />
                          ))}
                        </div>
                      ) : null}
                      <p className="t-cap text-text-3">
                        {[
                          monitor.lastCheckedAt
                            ? t('monitor.last', { clock: clockOf(monitor.lastCheckedAt, format) })
                            : t('monitor.never'),
                          monitor.lastLatencyMs === null
                            ? null
                            : t('monitor.latency', { ms: monitor.lastLatencyMs }),
                          monitor.lastDetail,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      {uptime?.ratio !== null && uptime !== null ? (
                        <p className="t-cap text-text-3">
                          {t('monitor.uptime', {
                            percent: formatNumber(uptime.ratio * 100, format, {
                              minimumFractionDigits: 1,
                              maximumFractionDigits: 1,
                            }),
                            count: uptime.samples,
                          })}
                        </p>
                      ) : null}
                    </>
                  )}
                </CardContent>
              </Card>
            </>
          }
        />
      </>
    ),
  };
}

/** A pass's color, in the band of the last results. */
const STRIP_CLASS: Record<string, string> = {
  healthy: '',
  unhealthy: 'w',
  unreachable: 'd',
  unknown: 'n',
};

function ScanSummary({
  canRead,
  scan,
  t,
}: {
  canRead: boolean;
  scan: {
    verdict: string | null;
    scanners: string[];
    counts: { CRITICAL: number; HIGH: number };
  } | null;
  t: T;
}) {
  if (!canRead) return <span className="t-cap text-text-3">{t('scan.restricted')}</span>;
  if (!scan || scan.scanners.length === 0) {
    return <span className="t-cap text-text-3">{t('scan.none')}</span>;
  }
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge
          variant={scan.verdict === 'fail' ? 'danger' : scan.verdict === 'pass' ? 'ok' : 'idle'}
        >
          {scan.verdict === 'fail'
            ? t('scan.verdict.fail')
            : scan.verdict === 'pass'
              ? t('scan.verdict.pass')
              : t('scan.verdict.none')}
        </Badge>
      </span>
      <span className="t-cap text-text-3">
        {t('scan.critical', { count: scan.counts.CRITICAL })} ·{' '}
        {t('scan.high', { count: scan.counts.HIGH })}
      </span>
      <span className="t-cap text-text-3">
        {t('scan.when', { scanners: scan.scanners.join(' · ') })}
      </span>
    </span>
  );
}

/** The time the release took, when both bounds are known. */
function deployDuration(startedAt: Date | null, finishedAt: Date | null, t: T): string {
  if (!startedAt || !finishedAt) return '—';
  const seconds = Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000));
  if (seconds < 60) return t('duration.seconds', { seconds });
  return t('duration.minutes', {
    minutes: Math.floor(seconds / 60),
    seconds: String(seconds % 60).padStart(2, '0'),
  });
}

/** "12 min", "3 h": an incident's age, in the monitoring units. */
function shortAge(date: Date, t: Translate<typeof servers.fr>): string {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return t('since.seconds', { count: seconds });
  if (seconds < 3600) return t('since.minutes', { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('since.hours', { count: Math.floor(seconds / 3600) });
  return t('since.days', { count: Math.floor(seconds / 86400) });
}

function clockOf(date: Date, format: FormatSettings): string {
  return formatDateTimeWith(date, format, { hour: '2-digit', minute: '2-digit' });
}
