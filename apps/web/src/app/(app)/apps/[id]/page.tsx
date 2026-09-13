import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { isSupervisable, parseAppSpec } from '@pupitre/core';
import {
  getAppSettings,
  getDeploymentForRun,
  getDeploymentSummary,
  listMonitors,
  listSupervisedApps,
  resolveThresholds,
  scanDigestForDeployments,
  targetHistories,
  uptimeWindows,
} from '@pupitre/db';
import { z } from 'zod';
import { MiniGauge, MicroSpark } from '@/components/chart';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { formatSettingsOf, createDateFormatter } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { AppActions } from './app-actions';
import { AppConsole, type ConsoleApp, type ConsoleService } from './app-console';

export const dynamic = 'force-dynamic';

/**
 * Fenêtre des relevés machine rendue avec la page. Même cadrage que l'écran de
 * supervision par serveur — 24 h en 48 intervalles — pour qu'une frise lue ici
 * et une frise lue là-bas veuillent dire la même chose.
 */
const HISTORY_HOURS = 24;
const HISTORY_BUCKETS = 48;

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * L'écran d'une application en marche.
 *
 * On l'ouvre quand quelque chose ne va pas, souvent à une heure indue, et il
 * doit répondre à quatre questions dans cet ordre : **est-ce que ça tourne**,
 * **depuis quand et dans quel état**, **qu'est-ce que ça dit**, **qu'est-ce que
 * ça consomme**.
 *
 * Deux sources, jamais mélangées — c'est la règle de tout l'écran :
 *
 *   - la **base** dit ce qu'on a voulu poser (version, AppSpec, auteur, date,
 *     scan, seuils). Elle répond toujours, machine éteinte comprise, et elle
 *     est rendue ici, côté serveur ;
 *   - la **machine** dit ce qui tourne *à l'instant*. Cela n'arrive que par le
 *     flux, dans `AppConsole`, et son absence se dit — elle ne se déguise pas
 *     en « aucun conteneur ».
 */
export default async function AppPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const auth = await requirePagePermission(`/apps/${parsed.data.id}`, 'deployment:read');
  const deployment = await getDeploymentSummary(parsed.data.id);
  if (!deployment) notFound();

  if (!isSupervisable(deployment.status)) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          eyebrow="Supervision"
          title={deployment.applicationSlug}
          description="Ce déploiement ne tourne plus."
        />
        <Alert variant="destructive">
          Ce déploiement est « {deployment.status} » : il n&apos;y a pas d&apos;application à
          suivre. Consultez son{' '}
          <Link href={`/deployments/${deployment.id}`} className="underline underline-offset-4">
            historique de déploiement
          </Link>
          .
        </Alert>
      </div>
    );
  }

  const canReadTargets = auth.can('target:read');
  const canReadScans = auth.can('scan:read');
  const canReadMonitors = auth.can('monitor:read');

  // `listSupervisedApps` porte la santé et l'échec de mise à jour éventuel ; on
  // y relit cette application plutôt que de recomposer l'information à la main.
  const [supervisedAll, run, { settings }, scanDigests, monitors] = await Promise.all([
    listSupervisedApps(),
    // Une seule requête pour l'AppSpec figée du déploiement *et* ses étapes.
    getDeploymentForRun(deployment.id),
    getAppSettings(),
    canReadScans ? scanDigestForDeployments([deployment.id]) : Promise.resolve(null),
    canReadMonitors ? listMonitors() : Promise.resolve([]),
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
  const uptime = monitor ? (await uptimeWindows([monitor.id], 24)).get(monitor.id) ?? null : null;

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

  const view: ConsoleApp = {
    id: deployment.id,
    applicationId: deployment.applicationId,
    applicationSlug: deployment.applicationSlug,
    targetId: deployment.targetId,
    targetName: deployment.targetName,
    targetHost: deployment.targetHost,
    runtime: deployment.runtime,
    version: deployment.version,
    specVersion: spec?.version ?? null,
    url: deployment.url,
    publishedPort: deployment.publishedPort,
    healthStatus: supervised?.healthStatus ?? 'unknown',
    lastHealthAt: supervised?.lastHealthAt?.toISOString() ?? null,
    onlineSince: (deployment.finishedAt ?? deployment.createdAt).toISOString(),
    services,
    uptime24h: uptime?.ratio ?? null,
    uptimeSamples: uptime?.samples ?? 0,
    restored: deployment.status === 'rolled_back',
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <Link
            href="/apps"
            className="hover:text-ink inline-flex items-center gap-1 transition-colors"
          >
            <ChevronLeft className="size-3" />
            Supervision
          </Link>
        }
        title={deployment.applicationSlug}
        description="Ce que la machine dit d’elle-même, relu en direct. La colonne de gauche vient de la base du panel — elle répond même quand la machine se tait."
        actions={
          <AppActions
            deploymentId={deployment.id}
            applicationId={deployment.applicationId}
            applicationSlug={deployment.applicationSlug}
            targetName={deployment.targetName}
            runtime={deployment.runtime}
            canDeploy={auth.can('deployment:create')}
            canDestroy={auth.can('deployment:destroy')}
          />
        }
      />

      {/* La version affichée n'est pas forcément la dernière qu'on a voulu poser. */}
      {supervised?.lastFailedUpdate ? (
        <Alert variant="warn">
          La dernière mise à jour de cette application a échoué (déploiement #
          {supervised.lastFailedUpdate.version}
          {supervised.lastFailedUpdate.failedStep
            ? `, étape ${supervised.lastFailedUpdate.failedStep}`
            : ''}
          ). C&apos;est la version ci-dessous qui reste en service.{' '}
          <Link
            href={`/deployments/${supervised.lastFailedUpdate.deploymentId}`}
            className="underline underline-offset-4"
          >
            Voir le déploiement échoué
          </Link>
          .
        </Alert>
      ) : null}

      <AppConsole
        app={view}
        /*
          Rendus côté serveur et glissés dans la colonne de gauche : ce sont des
          lectures SQL, elles n'ont aucune raison de traverser le navigateur ni
          d'attendre l'ouverture du flux.
        */
        context={
          <>
            <Panel
              title="Mise en ligne"
              aside={
                <Link
                  href={`/deployments/${deployment.id}`}
                  className="hover:text-signal text-ink-faint text-xs underline-offset-4 hover:underline"
                >
                  Voir la trace
                </Link>
              }
            >
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 py-3.5">
                <Field label="Version">
                  #{deployment.version}
                  {view.specVersion ? (
                    <span className="text-ink-faint"> · spec {view.specVersion}</span>
                  ) : null}
                </Field>
                <Field label="Runtime">{deployment.runtime}</Field>
                <Field label="Mise en ligne">
                  {formatDate(deployment.finishedAt ?? deployment.createdAt)}
                </Field>
                <Field label="Durée">{deployDuration(deployment.startedAt, deployment.finishedAt)}</Field>
                <Field label="Déclenchée par" wide>
                  {deployment.triggeredByEmail ?? 'origine inconnue'}
                </Field>
                {failedStep ? (
                  <Field label="Étape en échec" wide>
                    <span className="text-danger">{failedStep.label}</span>
                  </Field>
                ) : null}
              </dl>

              {/*
                Le scan appartient à cette mise en ligne, pas à l'instant
                présent : il a tourné sur les images de cette version, une fois.
                Lui donner un panneau à lui laissait croire à une surveillance
                continue — il est donc en pied de la mise en ligne, là où le
                lecteur vient de lire la date.
              */}
              <div className="border-line flex flex-wrap items-center gap-2 border-t px-5 py-3">
                {!canReadScans ? (
                  <span className="text-ink-faint text-[0.8125rem]">
                    Lire les scans demande la permission scan:read.
                  </span>
                ) : !scan || scan.scanners.length === 0 ? (
                  <span className="text-ink-faint text-[0.8125rem]">
                    Aucun scan n’a tourné pour cette version.
                  </span>
                ) : (
                  <>
                    <Badge variant={scan.verdict === 'fail' ? 'destructive' : scan.verdict === 'pass' ? 'ok' : 'secondary'}>
                      {scan.verdict === 'fail'
                        ? 'seuil dépassé'
                        : scan.verdict === 'pass'
                          ? 'sous le seuil'
                          : 'sans verdict'}
                    </Badge>
                    <span className="text-ink-muted font-mono text-xs">
                      {scan.counts.CRITICAL} critique{scan.counts.CRITICAL > 1 ? 's' : ''} ·{' '}
                      {scan.counts.HIGH} élevée{scan.counts.HIGH > 1 ? 's' : ''}
                    </span>
                    <span className="text-ink-faint w-full text-[0.6875rem]">
                      {scan.scanners.join(' · ')} — au moment de la mise en ligne, pas maintenant
                    </span>
                  </>
                )}
              </div>
            </Panel>

            <Panel
              title="La machine"
              aside={
                canReadTargets ? (
                  <Link
                    href={`/targets/${deployment.targetId}`}
                    className="hover:text-signal text-ink-faint text-xs underline-offset-4 hover:underline"
                  >
                    {deployment.targetName}
                  </Link>
                ) : (
                  <span className="text-ink-faint text-xs">{deployment.targetName}</span>
                )
              }
            >
              <div className="space-y-2.5 px-5 py-3.5">
                {!canReadTargets ? (
                  <p className="text-ink-faint text-[0.8125rem]">
                    Lire les relevés machine demande la permission target:read.
                  </p>
                ) : history && history.samples > 0 ? (
                  <>
                    <div className="flex items-center gap-3">
                      <MicroSpark
                        values={history.points.map((point) => point.loadPercent)}
                        max={Math.max(
                          thresholds?.load.limitPercent ?? 100,
                          history.summary.load.worst ?? 0,
                        )}
                        tone={
                          (history.summary.load.worst ?? 0) >= (thresholds?.load.limitPercent ?? 100)
                            ? 'var(--warn)'
                            : 'var(--signal)'
                        }
                        width={72}
                      />
                      <MiniGauge
                        label="chg"
                        value={history.summary.load.last}
                        tone={
                          (history.summary.load.last ?? 0) >= (thresholds?.load.limitPercent ?? 100)
                            ? 'var(--warn)'
                            : 'var(--signal)'
                        }
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <MiniGauge
                        label="mém"
                        value={history.summary.memory.last}
                        tone={
                          (history.summary.memory.last ?? 0) >=
                          (thresholds?.memory.limitPercent ?? 100)
                            ? 'var(--warn)'
                            : 'var(--signal)'
                        }
                      />
                      <MiniGauge
                        label="dsk"
                        value={history.summary.disk.last}
                        tone={
                          (history.summary.disk.last ?? 0) >= (thresholds?.disk.limitPercent ?? 100)
                            ? 'var(--warn)'
                            : 'var(--signal)'
                        }
                      />
                    </div>
                    <p className="text-ink-faint text-[0.6875rem]">
                      la machine entière sur {HISTORY_HOURS} h, pas cette application — la
                      consommation par conteneur n’est pas relevée.
                    </p>
                  </>
                ) : (
                  <p className="text-ink-faint text-[0.8125rem]">
                    Aucun relevé sur {HISTORY_HOURS} h pour cette machine.
                  </p>
                )}
              </div>
            </Panel>

            <Panel
              title="Sonde de site"
              aside={
                monitor ? (
                  <Link
                    href="/monitors"
                    className="hover:text-signal text-ink-faint text-xs underline-offset-4 hover:underline"
                  >
                    {monitor.name}
                  </Link>
                ) : null
              }
            >
              <div className="space-y-1.5 px-5 py-3.5 text-[0.8125rem]">
                {!canReadMonitors ? (
                  <p className="text-ink-faint">
                    Lire les sondes demande la permission monitor:read.
                  </p>
                ) : !monitor ? (
                  <p className="text-ink-faint">
                    Aucune sonde ne surveille cette application depuis l’extérieur.{' '}
                    <Link href="/monitors" className="underline underline-offset-4">
                      En poser une
                    </Link>
                    .
                  </p>
                ) : (
                  <>
                    <div className="text-ink-muted">
                      Dernier passage : {formatDate(monitor.lastCheckedAt)}
                      {monitor.lastLatencyMs === null ? '' : ` · ${monitor.lastLatencyMs} ms`}
                    </div>
                    {monitor.lastDetail ? (
                      <div className="text-ink-faint font-mono text-[0.6875rem]">
                        {monitor.lastDetail}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </Panel>
          </>
        }
      />
    </div>
  );
}

/**
 * Coque de panneau de la colonne de gauche.
 *
 * Une `Card` par bloc empilerait des cadres de tailles inégales ; ici tous les
 * blocs partagent la même mesure d'en-tête que les panneaux du tableau de bord,
 * pour que la colonne se lise comme une seule face avant.
 */
function Panel({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-line bg-card shadow-panel min-w-0 rounded-lg border">
      <div className="border-line flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-5 py-3.5">
        <h2 className="text-ink font-condensed text-[0.9375rem] font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={wide ? 'col-span-2 min-w-0' : 'min-w-0'}>
      <dt className="eyebrow text-ink-faint">{label}</dt>
      <dd className="text-ink truncate font-mono text-xs">{children}</dd>
    </div>
  );
}

/** Le temps qu'a pris la mise en ligne, quand les deux bornes sont connues. */
function deployDuration(startedAt: Date | null, finishedAt: Date | null): string {
  if (!startedAt || !finishedAt) return '—';
  const seconds = Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}
