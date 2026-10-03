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
 * Fenêtre des relevés machine rendue avec la fiche. Même cadrage que l'écran de
 * supervision par serveur — 24 h en 48 intervalles — pour qu'une frise lue ici
 * et une frise lue là-bas veuillent dire la même chose.
 */
const HISTORY_HOURS = 24;
const HISTORY_BUCKETS = 48;

/** Les derniers passages de la sonde, en bande : assez pour voir une panne qui dure. */
const MONITOR_STRIP = 36;

type T = Translate<typeof appConsole.fr>;

export type RunningAppRecord = {
  /** L'identifiant du déploiement en service : c'est la clé du tiroir. */
  key: string;
  header: {
    applicationSlug: string;
    targetName: string;
    url: string | null;
    restored: boolean;
    health: HealthStatus | null;
  };
  /** Les gestes sur l'application (redéployer, revenir, détruire…) ; `null` quand elle ne tourne plus. */
  actions: ReactNode;
  body: ReactNode;
};

/**
 * Une application en marche, rendue au serveur pour son tiroir.
 *
 * On l'ouvre quand quelque chose ne va pas, souvent à une heure indue, et elle
 * doit répondre à quatre questions dans cet ordre : **est-ce que ça tourne**,
 * **depuis quand et dans quel état**, **qu'est-ce que ça dit**, **qu'est-ce que
 * ça consomme**.
 *
 * Deux sources, jamais mélangées :
 *
 *   - la **base** dit ce qu'on a voulu poser (version, AppSpec, auteur, date,
 *     scan, seuils). Elle répond toujours, machine éteinte comprise, et elle
 *     est rendue ici ;
 *   - la **machine** dit ce qui tourne *à l'instant*. Cela n'arrive que par le
 *     flux, dans `AppConsole`, et son absence se dit — elle ne se déguise pas
 *     en « aucun conteneur ».
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

  // `listSupervisedApps` porte la santé et l'échec de mise à jour éventuel ; on
  // y relit cette application plutôt que de recomposer l'information à la main.
  const [supervisedAll, run, { settings }, scanDigests, monitors, tCommon, tServers] =
    await Promise.all([
      listSupervisedApps(),
      // Une seule requête pour l'AppSpec figée du déploiement *et* ses étapes.
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
   * L'AppSpec **figée dans le déploiement**, pas celle de l'application.
   *
   * C'est ce qui est réellement posé sur la machine. Lire la spec courante de
   * l'application donnerait l'inventaire de la prochaine version, pas de celle
   * qui tourne — exactement l'erreur qu'un écran de supervision ne doit pas
   * faire.
   */
  const spec = run ? parseAppSpec(run.deployment.appSpec) : null;
  const specVersion = spec?.version ?? null;

  const services: ConsoleService[] = (spec?.services ?? []).map((service) => ({
    name: service.name,
    // Pour une image tirée d'un registre, la spec la nomme. Pour une image
    // construite sur la cible, seul le runtime connaît son nom final : on ne le
    // devine pas ici, le relevé le dira.
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

  // La sonde de site de cette application, s'il y en a une. Le lien est porté
  // par l'application, jamais par le déploiement : une sonde survit aux
  // versions.
  const monitor = monitors.find((row) => row.applicationId === deployment.applicationId) ?? null;
  const [uptime, checks, incident] = monitor
    ? await Promise.all([
        uptimeWindows([monitor.id], 24).then((windows) => windows.get(monitor.id) ?? null),
        listChecks(monitor.id, MONITOR_STRIP),
        openIncidentFor(monitor.id),
      ])
    : [null, [], null];

  // Le passé de la machine vient de la base, pas de la machine : il s'affiche
  // même quand elle ne répond plus, ce qui est précisément le moment où on le
  // regarde.
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
        {/* La version affichée n'est pas forcément la dernière qu'on a voulu poser. */}
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
            Rendus côté serveur et glissés dans la colonne de gauche : ce sont des
            lectures SQL, elles n'ont aucune raison de traverser le navigateur ni
            d'attendre l'ouverture du flux.
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
                  Le scan appartient à cette mise en ligne, pas à l'instant
                  présent : il a tourné sur les images de cette version, une
                  fois. Il est donc un champ de la mise en ligne, à côté de sa
                  date, et non une surveillance à part.
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

/** La couleur d'un passage, dans la bande des derniers résultats. */
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

/** Le temps qu'a pris la mise en ligne, quand les deux bornes sont connues. */
function deployDuration(startedAt: Date | null, finishedAt: Date | null, t: T): string {
  if (!startedAt || !finishedAt) return '—';
  const seconds = Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000));
  if (seconds < 60) return t('duration.seconds', { seconds });
  return t('duration.minutes', {
    minutes: Math.floor(seconds / 60),
    seconds: String(seconds % 60).padStart(2, '0'),
  });
}

/** « 12 min », « 3 h » : l'âge d'un incident, dans les unités de la supervision. */
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
