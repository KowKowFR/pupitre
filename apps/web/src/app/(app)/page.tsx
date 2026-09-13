import Link from 'next/link';
import {
  activityPulse,
  deploymentPulse,
  deploymentQuerySchema,
  foldFleet,
  HOST_METRIC_CATALOG,
  listApplications,
  listDeployments,
  listMonitors,
  listSupervisedApps,
  listTargets,
  monitorPulse,
  pulseWindow,
  scanPosture,
  targetHistories,
  type ActivityPulse,
  type DeploymentPulse,
  type DeploymentSummary,
  type FleetPulse,
  type MonitorPulse,
  type PublicTarget,
  type ScanPosture,
  type TargetHistory,
} from '@pupitre/db';
import {
  ChartLegend,
  CoverageNote,
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
import { currentAuth } from '@/lib/page-auth';
import { AttentionPanel, Panel, PanelEmpty, type AttentionItem } from './attention';
import { DeploymentStatusBadge } from './deployments/status-badge';

export const dynamic = 'force-dynamic';

/**
 * Poste d'exploitation.
 *
 * ── L'ordre de lecture ──────────────────────────────────────────────────────
 * Il reste celui qui était déjà écrit ici, et il tient : **les anomalies
 * d'abord, l'inventaire en dernier**. Un opérateur ouvre cet écran pour savoir
 * s'il doit intervenir, pas pour compter ses machines.
 *
 * Ce qui manquait n'était pas l'ordre, c'était le **milieu**. Entre « qu'est-ce
 * qui brûle » et « qu'est-ce que je possède », il n'y avait rien : tout l'écran
 * parlait de l'instant présent. On ne pouvait pas voir qu'une sonde s'était
 * dégradée dans la nuit, ni qu'un déploiement s'était replié il y a deux
 * heures. C'est cette bande temporelle qui est ajoutée, et elle se glisse
 * exactement là — après l'alarme, avant l'inventaire.
 *
 * ── La fenêtre est de 24 heures, et ce n'est pas un défaut ──────────────────
 * On aurait aimé « depuis la semaine dernière ». Les données ne le permettent
 * pas, et il vaut mieux l'écrire que le maquiller : sur cette instance, les
 * relevés machine couvrent deux heures, les mesures de sonde trente-quatre, et
 * les déploiements trente-six. Un axe de sept jours serait vide aux cinq
 * sixièmes, et un axe vide se lit comme une panne. Vingt-quatre heures est la
 * plus longue fenêtre que les séries denses remplissent réellement ; la
 * chronique des déploiements, elle, garde sept jours parce qu'elle compte des
 * événements rares et qu'un événement rare ne se dilue pas.
 *
 * ── Le mensonge qu'on refuse ────────────────────────────────────────────────
 * Chaque figure sort de la base avec son dénombrement, et aucune ne dessine un
 * zéro là où rien n'a été mesuré. Une heure sans relevé est un moignon gris,
 * une heure à une seule mesure est hachurée, et une série trop maigre est
 * remplacée par la phrase qui dit combien il manque. « 100 % de disponibilité »
 * sur trois mesures ne s'affiche pas comme un taux.
 *
 * ── RBAC ────────────────────────────────────────────────────────────────────
 * Chaque bloc n'est rendu que si la permission correspondante est accordée, et
 * une anomalie qu'on n'a pas le droit de voir n'entre pas dans le décompte. Les
 * agrégats temporels suivent la même règle : une piste de la bande disparaît
 * plutôt que de s'afficher vide.
 */

/** La fenêtre dense. Un seau par heure — voir `monitorPulse` pour le pourquoi. */
const WINDOW_HOURS = 24;
const WINDOW_BUCKETS = 24;

/** La chronique des événements rares. Sept jours, parce qu'on y compte des faits. */
const CHRONICLE_DAYS = 7;

/** Sous ce nombre de mesures, un pourcentage est une mise en scène. */
const RATE_FLOOR = 20;

const HEALTH_TONE: Record<string, Tone> = {
  healthy: 'ok',
  unhealthy: 'warn',
  unreachable: 'danger',
  unknown: 'idle',
};

const HEALTH_LABEL: Record<string, string> = {
  healthy: 'en marche',
  unhealthy: 'répond mal',
  unreachable: 'injoignable',
  unknown: 'état inconnu',
};

const DEPLOYMENT_TONE: Record<string, Tone> = {
  success: 'ok',
  failed: 'danger',
  rolled_back: 'warn',
  destroyed: 'idle',
  running: 'signal',
  pending: 'signal',
};

/** « il y a 3 min ». Rend `null` plutôt qu'un tiret : l'appelant décide. */
function since(date: Date | null): string | null {
  if (!date) return null;
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `il y a ${seconds} s`;
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `il y a ${Math.floor(seconds / 3600)} h`;
  return `il y a ${Math.floor(seconds / 86_400)} j`;
}

/** Médiane d'une série éparse. `null` sous trois valeurs — deux n'en ont pas. */
function median(values: readonly (number | null)[]): number | null {
  const clean = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (clean.length < 3) return null;
  return clean[Math.floor(clean.length / 2)] ?? null;
}

export default async function HomePage() {
  const auth = await currentAuth('/');

  const canReadTargets = auth?.can('target:read') ?? false;
  const canReadDeployments = auth?.can('deployment:read') ?? false;
  const canReadApplications = auth?.can('application:read') ?? false;
  const canReadMonitors = auth?.can('monitor:read') ?? false;
  const canReadScans = auth?.can('scan:read') ?? false;
  const canReadAudit = auth?.can('audit:read') ?? false;

  const window = pulseWindow(WINDOW_HOURS, WINDOW_BUCKETS);

  // Les cibles d'abord : leurs identifiants conditionnent l'historique du parc.
  // Une lecture indexée sur cinq lignes, puis tout le reste en parallèle.
  const targets = canReadTargets ? await listTargets() : ([] as PublicTarget[]);

  const [deployments, applications, running, monitors, pulse, activity, chronicle, posture, histories] =
    await Promise.all([
      canReadDeployments
        ? listDeployments(deploymentQuerySchema.parse({ pageSize: '6' }))
        : Promise.resolve(null),
      canReadApplications ? listApplications() : Promise.resolve([]),
      canReadDeployments ? listSupervisedApps() : Promise.resolve([]),
      canReadMonitors ? listMonitors() : Promise.resolve([]),
      canReadMonitors ? monitorPulse(WINDOW_HOURS, WINDOW_BUCKETS) : Promise.resolve(null),
      canReadAudit ? activityPulse(WINDOW_HOURS, WINDOW_BUCKETS) : Promise.resolve(null),
      canReadDeployments ? deploymentPulse(CHRONICLE_DAYS) : Promise.resolve(null),
      canReadScans ? scanPosture(CHRONICLE_DAYS) : Promise.resolve(null),
      canReadTargets
        ? targetHistories(
            targets.map((target) => target.id),
            WINDOW_HOURS,
            WINDOW_BUCKETS,
          )
        : Promise.resolve(new Map<string, TargetHistory>()),
    ]);

  const fleet = canReadTargets ? foldFleet(histories.values(), window) : null;

  const recent: DeploymentSummary[] = deployments?.items ?? [];
  const inFlight = recent.filter(
    (item) => item.status === 'running' || item.status === 'pending',
  ).length;
  const targetsUp = targets.filter((target) => target.status === 'ok').length;
  // Une cible jamais testée n'est pas une cible en panne : c'est une
  // installation qu'on n'a pas finie. Les confondre faisait dire deux choses
  // contraires au même écran — « rien ne demande d'intervention » en tête, et
  // un relevé orange en bas pour des machines dont on ignore simplement l'état.
  const targetsUntested = targets.filter((target) => target.status === 'unknown').length;
  const targetsDown = targets.length - targetsUp - targetsUntested;
  const monitorsUp = monitors.filter((monitor) => monitor.status === 'healthy').length;
  const appsHealthy = running.filter((app) => app.healthStatus === 'healthy').length;

  const attention = collectAttention({ targets, running, monitors, recent, chronicle, posture });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Poste d'exploitation"
        title="Tableau de bord"
        description="Ce qui demande une intervention, ce qui s'est passé depuis hier, puis l'état du parc."
      />

      <AttentionPanel items={attention} />

      <PulseBand
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
      />

      {canReadTargets ? <FleetPanel targets={targets} histories={histories} /> : null}

      {/*
        `items-start` et non l'alignement par défaut : ces deux blocs n'ont
        aucune raison d'avoir la même hauteur. La grille les étirait, et une
        liste d'une seule ligne se retrouvait au milieu d'une boîte de 260 px
        de vide — c'était la moitié du blanc de l'écran.
      */}
      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-2">
        <Panel
          title="En marche"
          href={canReadDeployments ? '/apps' : undefined}
          linkLabel="Supervision"
          hint={canReadDeployments ? undefined : 'accès restreint'}
        >
          {running.length === 0 ? (
            <PanelEmpty>
              Aucune application en marche. Déployez-en une depuis{' '}
              <Link href="/applications" className="text-signal underline underline-offset-4">
                Applications
              </Link>
              .
            </PanelEmpty>
          ) : (
            <ul className="divide-line divide-y">
              {running.slice(0, 6).map((app) => (
                <li
                  key={app.id}
                  className="flex items-center gap-3 px-5 py-2.5 text-[0.8125rem]"
                >
                  <Led tone={HEALTH_TONE[app.healthStatus] ?? 'idle'} />
                  <Link
                    href={`/apps/${app.id}`}
                    className="text-ink min-w-0 flex-1 truncate font-mono underline-offset-4 hover:underline"
                  >
                    {app.applicationSlug}
                    <span className="text-ink-faint">@{app.targetName}</span>
                  </Link>
                  <span className="text-ink-muted shrink-0">
                    {HEALTH_LABEL[app.healthStatus] ?? app.healthStatus}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <DeploymentsPanel
          recent={recent}
          chronicle={chronicle}
          canReadDeployments={canReadDeployments}
        />
      </div>

      {/*
        L'inventaire ferme l'écran au lieu de l'ouvrir : ces chiffres rassurent,
        ils ne déclenchent rien. Les mettre en tête repousserait plus bas la
        seule information pour laquelle on ouvre un tableau de bord.
      */}
      <ReadoutBar>
        <Readout
          label="Cibles prêtes"
          value={targetsUp}
          unit={`/ ${targets.length}`}
          tone={
            !canReadTargets || targets.length === 0
              ? 'idle'
              : targetsDown > 0
                ? 'warn'
                : targetsUntested > 0
                  ? 'idle'
                  : 'ok'
          }
          hint={targetsHint({ canReadTargets, targetsDown, targetsUntested })}
        />
        <Readout
          label="Applications en marche"
          value={appsHealthy}
          unit={`/ ${running.length}`}
          tone={running.length === 0 ? 'idle' : appsHealthy === running.length ? 'ok' : 'warn'}
          hint={`${applications.length} déclarée${applications.length > 1 ? 's' : ''}`}
        />
        <Readout
          label="Sondes au vert"
          value={monitorsUp}
          unit={`/ ${monitors.length}`}
          tone={monitors.length === 0 ? 'idle' : monitorsUp === monitors.length ? 'ok' : 'warn'}
          hint={canReadMonitors ? 'supervision de sites' : 'accès restreint'}
        />
        <Readout
          label="En vol"
          value={inFlight}
          tone={inFlight > 0 ? 'signal' : 'idle'}
          pulse={inFlight > 0}
          hint={inFlight > 0 ? 'déploiement en cours' : 'aucun déploiement en cours'}
        />
      </ReadoutBar>
    </div>
  );
}

// ─── la bande temporelle ──────────────────────────────────────────────────────

/**
 * Les dernières vingt-quatre heures, sur un axe unique.
 *
 * Les trois pistes partagent exactement les mêmes bornes de seau — c'est garanti
 * par `pulseWindow`, dont l'alignement sur l'époque est le même que celui de
 * `targetHistories`. C'est ce qui permet de lire verticalement : le déploiement
 * de 00 h 33 tombe au-dessus du creux de charge de 00 h 33, et on n'a pas eu à
 * croiser deux écrans pour s'en apercevoir.
 *
 * Une piste dont on n'a pas la permission n'est pas grisée : elle n'existe pas.
 */
function PulseBand({
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
}: {
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
}) {
  const lanes = [canReadMonitors, canReadTargets, canReadDeployments].filter(Boolean).length;
  if (lanes === 0) {
    return (
      <Panel title="Les dernières 24 heures" hint="accès restreint">
        <PanelEmpty>
          Aucune des séries de cet écran n&apos;est accessible avec vos permissions.
        </PanelEmpty>
      </Panel>
    );
  }

  const monitorSamples = pulse?.coverage.samples ?? 0;
  const monitorHealthy = pulse?.points.reduce((sum, point) => sum + point.healthy, 0) ?? 0;
  const latencyMedian = median(pulse?.points.map((point) => point.latencyAvgMs) ?? []);
  const fleetPeak = fleet
    ? Math.max(0, ...fleet.points.map((point) => point.loadPercent ?? 0))
    : 0;

  return (
    <section className="border-line bg-card shadow-panel min-w-0 rounded-lg border">
      <div className="border-line flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-5 py-3.5">
        <h2 className="text-ink font-condensed text-[0.9375rem] font-semibold">
          Les dernières 24 heures
        </h2>
        <span className="text-ink-faint text-xs">
          un intervalle par heure — chaque figure porte son nombre de mesures
        </span>
      </div>

      {/*
        Les relevés temporels. Ce sont des variations, pas un inventaire :
        l'inventaire est en bas d'écran et n'a pas à être répété ici.

        Le seuil est `@3xl`, le même que `ReadoutBar`, et pour la même raison :
        à 1024 px de fenêtre le rail prend 248 px et il ne reste que 712 px. En
        `@2xl` (672 px) quatre colonnes tenaient tout juste et tronquaient
        « médiane des moyennes horaires » en « médiane des moyennes ho… ».
        C'est une requête de conteneur et non de fenêtre pour que le bon seuil
        ne dépende pas de la largeur du rail de navigation.
      */}
      <div className="@container">
        <div className="divide-line border-line grid grid-cols-2 divide-x divide-y border-b @3xl:grid-cols-4 @3xl:divide-y-0">
          <Readout
            label="Disponibilité"
            value={
              monitorSamples === 0
                ? '—'
                : monitorSamples < RATE_FLOOR
                  ? monitorHealthy
                  : `${((monitorHealthy / monitorSamples) * 100).toFixed(1).replace('.', ',')}`
            }
            unit={
              monitorSamples === 0
                ? undefined
                : monitorSamples < RATE_FLOOR
                  ? `/ ${monitorSamples}`
                  : '%'
            }
            /*
              Vert seulement quand le vert veut dire quelque chose. Sous le
              plancher de mesures, le voyant reste éteint : « tout va bien » sur
              deux relevés est une affirmation que la mesure ne soutient pas, et
              c'est un voyant vert qu'un exploitant croit sur parole. L'ambre,
              lui, reste dû dès qu'une mesure a échoué — un défaut constaté est
              un fait, même s'il est seul.
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
              !canReadMonitors
                ? 'accès restreint'
                : monitorSamples === 0
                  ? 'aucune mesure de sonde'
                  : monitorSamples < RATE_FLOOR
                    ? `mesures saines — trop peu pour un taux`
                    : `sur ${monitorSamples} mesures`
            }
          />
          <Readout
            label="Latence médiane"
            value={latencyMedian === null ? '—' : latencyMedian}
            unit={latencyMedian === null ? undefined : 'ms'}
            tone={latencyMedian === null ? 'idle' : 'signal'}
            hint={
              latencyMedian === null
                ? 'moins de 3 intervalles mesurés'
                : 'médiane des moyennes horaires'
            }
          />
          <Readout
            label="Charge maximale"
            value={fleet === null || fleet.coverage.samples === 0 ? '—' : Math.round(fleetPeak)}
            unit={fleet === null || fleet.coverage.samples === 0 ? undefined : '%'}
            /* Même règle que la disponibilité : un dépassement constaté se dit
               toujours, une absence de dépassement ne se célèbre qu'au-delà du
               plancher de relevés. */
            tone={
              fleet === null || fleet.coverage.samples === 0
                ? 'idle'
                : fleetPeak >= HOST_METRIC_CATALOG.load.defaultLimitPercent
                  ? 'warn'
                  : fleet.coverage.samples < RATE_FLOOR
                    ? 'idle'
                    : 'ok'
            }
            hint={
              !canReadTargets
                ? 'accès restreint'
                : fleet === null || fleet.coverage.samples === 0
                  ? 'aucun relevé machine'
                  : `pire machine du parc · ${fleet.coverage.covered}/${fleet.coverage.buckets} h couvertes`
            }
          />
          <Readout
            label="Refus d'accès"
            value={activity === null ? '—' : activity.denied}
            tone={activity === null ? 'idle' : activity.denied > 0 ? 'warn' : 'ok'}
            hint={
              !canReadAudit
                ? 'accès restreint'
                : activity === null
                  ? ''
                  : `sur ${activity.total.toLocaleString('fr-FR')} actions journalisées`
            }
          />
        </div>
      </div>

      <div className="flex flex-col gap-4 px-5 py-4">
        {canReadMonitors && pulse ? (
          <Lane
            title="Disponibilité des sondes"
            aside={
              pulse.monitorsSeen > 0
                ? `en % de mesures saines · ${pulse.monitorsSeen} sonde${pulse.monitorsSeen > 1 ? 's' : ''} active${pulse.monitorsSeen > 1 ? 's' : ''}`
                : 'en % de mesures saines'
            }
            href="/monitors"
          >
            <MonitorLane pulse={pulse} />
          </Lane>
        ) : null}

        {canReadMonitors && pulse ? (
          <Lane title="Latence des sondes" aside="en millisecondes, moyenne par heure" href="/monitors">
            <LatencyLane pulse={pulse} />
          </Lane>
        ) : null}

        {canReadTargets && fleet ? (
          <Lane
            title="Charge du parc"
            aside={`en %, pire machine — plafond ${HOST_METRIC_CATALOG.load.defaultLimitPercent} %`}
            href="/apps"
          >
            <FleetLane fleet={fleet} />
          </Lane>
        ) : null}

        {canReadDeployments && chronicle ? (
          <Lane
            title="Déploiements"
            aside={
              chronicle.events.length === 0
                ? `aucun sur ${CHRONICLE_DAYS} jours`
                : `${chronicle.events.length} sur ${CHRONICLE_DAYS} jours, dont ceux d'aujourd'hui`
            }
            href="/deployments"
          >
            <ChronicleLane chronicle={chronicle} posture={posture} window={window} />
          </Lane>
        ) : null}

        <TimeAxis from={window.from} to={window.to} />
      </div>
    </section>
  );
}

/** L'en-tête d'une piste : son nom, ce qu'elle mesure, et où elle mène. */
function Lane({
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
    <div className="min-w-0">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <Link
          href={href}
          className="eyebrow text-ink-muted hover:text-signal underline-offset-4 transition-colors hover:underline"
        >
          {title}
        </Link>
        {aside ? <span className="text-ink-faint text-[0.6875rem]">{aside}</span> : null}
      </div>
      {children}
    </div>
  );
}

function MonitorLane({ pulse }: { pulse: MonitorPulse }) {
  const buckets = pulse.points.map((point) => ({
    at: point.at,
    samples: point.samples,
    hits: point.healthy,
  }));
  const density = densityOf(buckets);

  if (density.verdict === 'none') {
    return (
      <NotEnoughHistory
        covered={0}
        buckets={pulse.coverage.buckets}
        nothing="Aucune mesure de sonde"
        since={pulse.coverage.firstAt}
      >
        <p className="text-ink-faint text-xs">
          Les sondes tournent par tâche planifiée. Vérifiez qu&apos;au moins une sonde est active
          sur{' '}
          <Link href="/monitors" className="text-signal underline underline-offset-4">
            Sondes
          </Link>
          .
        </p>
      </NotEnoughHistory>
    );
  }

  return (
    <>
      <RatioBars id="monitor-lane" buckets={buckets} label="Disponibilité des sondes" unit="sain" />
      <CoverageNote
        covered={density.covered}
        buckets={pulse.coverage.buckets}
        thin={density.thin}
        samples={density.samples}
        what="mesure"
        className="mt-0.5"
      />
      {/*
        La légende est ici et pas au pied de la bande : elle nomme les teintes
        *de ces barres*. Posée sous les quatre pistes, elle avait l'air de
        décrire aussi les courbes, qui n'emploient aucune de ces couleurs.
      */}
      <ChartLegend
        className="mt-1"
        items={[
          { color: 'var(--ok)', label: 'tout sain' },
          { color: 'var(--warn)', label: 'partiellement sain' },
          { color: 'var(--danger)', label: 'rien de sain' },
          { color: 'var(--ok)', label: 'moins de 3 mesures', hatched: true },
          { color: 'var(--ink-faint)', label: 'aucune mesure' },
        ]}
      />
    </>
  );
}

/**
 * La latence mesurée, heure par heure.
 *
 * Deuxième piste tirée des mêmes mesures que la disponibilité, et ce n'est pas
 * une redite : une sonde peut rester « saine » en devenant deux fois plus
 * lente, et c'est exactement le genre de dégradation qu'un tableau de bord de
 * l'instant ne peut pas montrer. Le plafond est arrondi au quart de seconde
 * supérieur plutôt que collé au maximum observé — une échelle qui se recadre à
 * chaque rendu ne se compare pas d'un jour sur l'autre.
 */
function LatencyLane({ pulse }: { pulse: MonitorPulse }) {
  const buckets = pulse.points.map((point) => ({
    at: point.at,
    // Sans latence relevée, le seau est vide : une sonde injoignable n'a pas
    // « mis 0 ms », elle n'a rien mesuré du tout.
    samples: point.latencyAvgMs === null ? 0 : point.samples,
    value: point.latencyAvgMs,
  }));
  const density = densityOf(buckets);

  if (density.verdict === 'none') {
    return (
      <NotEnoughHistory
        covered={0}
        buckets={pulse.coverage.buckets}
        nothing="Aucun temps de réponse"
        since={pulse.coverage.firstAt}
      />
    );
  }

  const peak = Math.max(...buckets.map((bucket) => bucket.value ?? 0));
  const ceiling = Math.max(50, Math.ceil(peak / 25) * 25);

  return (
    <>
      <SeriesLine buckets={buckets} label="Latence des sondes" max={ceiling} unit=" ms" />
      <CoverageNote
        covered={density.covered}
        buckets={pulse.coverage.buckets}
        thin={density.thin}
        samples={density.samples}
        what="mesure"
        className="mt-0.5"
      />
    </>
  );
}

function FleetLane({ fleet }: { fleet: FleetPulse }) {
  const buckets = fleet.points.map((point) => ({
    at: point.at,
    samples: point.samples,
    value: point.loadPercent,
  }));
  const density = densityOf(buckets);
  const ceiling = Math.max(
    HOST_METRIC_CATALOG.load.defaultLimitPercent,
    ...buckets.map((bucket) => bucket.value ?? 0),
  );

  if (density.verdict === 'none') {
    return (
      <NotEnoughHistory
        covered={0}
        buckets={fleet.coverage.buckets}
        nothing="Aucun relevé machine"
        since={fleet.coverage.firstAt}
      >
        <p className="text-ink-faint text-xs">
          Le balayage des machines écrit un relevé toutes les cinq minutes. S&apos;il n&apos;y en a
          aucun, la tâche planifiée ne tourne pas.
        </p>
      </NotEnoughHistory>
    );
  }

  return (
    <>
      <SeriesLine
        buckets={buckets}
        label="Charge maximale du parc"
        max={ceiling}
        unit="%"
      />
      <CoverageNote
        covered={density.covered}
        buckets={fleet.coverage.buckets}
        thin={density.thin}
        samples={density.samples}
        what="relevé"
        className="mt-0.5"
      />
      {density.verdict === 'sparse' ? (
        <p className="text-warn mt-0.5 text-[0.6875rem]">
          Trop peu d&apos;heures couvertes pour parler de tendance — la collecte vient de
          commencer.
        </p>
      ) : null}
    </>
  );
}

/**
 * Les événements de la fenêtre, posés à leur instant exact.
 *
 * La chronique interroge sept jours, la bande n'en montre que vingt-quatre
 * heures : les événements plus anciens sont comptés dans le résumé sous la
 * piste, mais ne sont pas dessinés hors de l'axe. Un point tassé contre le bord
 * gauche pour dire « quelque part avant » serait une position inventée.
 */
function ChronicleLane({
  chronicle,
  posture,
  window,
}: {
  chronicle: DeploymentPulse;
  posture: ScanPosture | null;
  window: ReturnType<typeof pulseWindow>;
}) {
  const start = Date.parse(window.from);
  const inWindow = chronicle.events.filter((event) => Date.parse(event.at) >= start);
  const older = chronicle.events.length - inWindow.length;

  const events: TimelineEvent[] = inWindow.map((event) => ({
    key: event.id,
    at: event.at,
    tone: DEPLOYMENT_TONE[event.status] ?? 'idle',
    title:
      `${event.applicationSlug} v${event.version} sur ${event.targetName} — ${STATUS_WORD[event.status] ?? event.status}` +
      (event.durationSeconds === null ? '' : ` · ${event.durationSeconds} s`) +
      (event.failedStep ? ` · étape « ${event.failedStep} »` : ''),
  }));

  if (events.length === 0) {
    return (
      <div className="border-line bg-surface-2/40 rounded-md border border-dashed px-4 py-3">
        <p className="text-ink text-[0.8125rem]">Aucun déploiement dans les 24 dernières heures.</p>
        <p className="text-ink-faint text-xs">
          {older === 0
            ? `Aucun non plus sur les ${CHRONICLE_DAYS} derniers jours.`
            : `${older} plus ancien${older > 1 ? 's' : ''} sur ${CHRONICLE_DAYS} jours — voir l'historique.`}
        </p>
      </div>
    );
  }

  return (
    <>
      <EventRail events={events} from={window.from} to={window.to} label="Déploiements" />
      <p className="text-ink-faint mt-0.5 text-[0.6875rem]">
        {events.length} dans la fenêtre
        {older > 0 ? ` · ${older} plus ancien${older > 1 ? 's' : ''} hors axe` : ''}
        {chronicle.medianDurationSeconds === null
          ? ' · durée médiane indisponible sous 3 pipelines'
          : ` · durée médiane ${chronicle.medianDurationSeconds} s`}
        {posture && posture.runs > 0 ? ` · ${posture.runs} analyses de sécurité` : ''}
      </p>
    </>
  );
}

const STATUS_WORD: Record<string, string> = {
  success: 'réussi',
  failed: 'échoué',
  rolled_back: 'replié',
  destroyed: 'retiré',
  running: 'en cours',
  pending: 'en attente',
};

// ─── le parc ──────────────────────────────────────────────────────────────────

/**
 * Une ligne par machine, avec la forme de sa charge sur la fenêtre.
 *
 * La micro-courbe ne porte pas d'échelle et n'en a pas besoin : le chiffre
 * lisible est à côté d'elle, et on ne lui demande que de montrer si ça monte.
 * Une machine sans relevé le dit en toutes lettres au lieu d'afficher une
 * courbe plate à zéro, qui se lirait « machine au repos ».
 */
function FleetPanel({
  targets,
  histories,
}: {
  targets: readonly PublicTarget[];
  histories: Map<string, TargetHistory>;
}) {
  if (targets.length === 0) {
    return (
      <Panel title="Machines" href="/targets" linkLabel="Cibles">
        <PanelEmpty>
          Aucune machine cible déclarée. Ajoutez-en une depuis{' '}
          <Link href="/targets" className="text-signal underline underline-offset-4">
            Cibles
          </Link>
          .
        </PanelEmpty>
      </Panel>
    );
  }

  const load = HOST_METRIC_CATALOG.load.defaultLimitPercent;
  const memory = HOST_METRIC_CATALOG.memory.defaultLimitPercent;
  const disk = HOST_METRIC_CATALOG.disk.defaultLimitPercent;

  return (
    <Panel title="Machines" href="/apps" linkLabel="Supervision">
      <div className="@container">
        <ul className="divide-line grid divide-y @3xl:grid-cols-2 @3xl:[&>li:nth-child(2n)]:border-l">
          {targets.map((target) => {
            const history = histories.get(target.id);
            const points = history?.points ?? [];
            const summary = history?.summary;
            const measured = (history?.samples ?? 0) > 0;

            return (
              <li key={target.id} className="border-line flex items-center gap-3 px-5 py-2.5">
                <Led
                  tone={
                    target.status === 'ok'
                      ? 'ok'
                      : target.status === 'unknown'
                        ? 'idle'
                        : target.status === 'degraded'
                          ? 'warn'
                          : 'danger'
                  }
                />
                <Link
                  href={`/targets/${target.id}`}
                  className="text-ink min-w-0 flex-1 truncate font-mono text-[0.8125rem] underline-offset-4 hover:underline"
                >
                  {target.name}
                  <span className="text-ink-faint"> {target.host}</span>
                </Link>

                {measured ? (
                  <>
                    <MicroSpark
                      values={points.map((point) => point.loadPercent)}
                      max={Math.max(load, summary?.load.worst ?? 0)}
                      tone={
                        (summary?.load.worst ?? 0) >= load ? 'var(--warn)' : 'var(--signal)'
                      }
                    />
                    <span className="hidden shrink-0 items-center gap-2.5 @xl:flex">
                      <MiniGauge
                        label="mém"
                        value={summary?.memory.last ?? null}
                        tone={
                          (summary?.memory.last ?? 0) >= memory ? 'var(--warn)' : 'var(--signal)'
                        }
                      />
                      <MiniGauge
                        label="dsk"
                        value={summary?.disk.last ?? null}
                        tone={(summary?.disk.last ?? 0) >= disk ? 'var(--warn)' : 'var(--signal)'}
                      />
                    </span>
                  </>
                ) : (
                  <span className="text-ink-faint shrink-0 text-[0.6875rem]">
                    aucun relevé sur 24 h
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Panel>
  );
}

// ─── les déploiements ─────────────────────────────────────────────────────────

/**
 * Les derniers déploiements, avec leur durée.
 *
 * La barre de durée est relative au plus long de la liste, pas à une échelle
 * absolue : ce qu'on cherche du coin de l'œil, c'est « celui-là a pris trois
 * fois plus de temps que les autres », jamais « il a pris 74 secondes » — ce
 * chiffre est écrit à côté.
 */
function DeploymentsPanel({
  recent,
  chronicle,
  canReadDeployments,
}: {
  recent: readonly DeploymentSummary[];
  chronicle: DeploymentPulse | null;
  canReadDeployments: boolean;
}) {
  const durations = new Map(
    (chronicle?.events ?? []).map((event) => [event.id, event.durationSeconds]),
  );
  const longest = Math.max(1, ...[...durations.values()].map((value) => value ?? 0));

  return (
    <Panel
      title="Derniers déploiements"
      href={canReadDeployments ? '/deployments' : undefined}
      linkLabel="Historique"
      hint={canReadDeployments ? undefined : 'accès restreint'}
    >
      {recent.length === 0 ? (
        <PanelEmpty>Aucun déploiement pour l&apos;instant.</PanelEmpty>
      ) : (
        /*
          Requête de conteneur, et pas `sm:` : ce qui manque de place ici, c'est
          le panneau, pas la fenêtre. À 1024 px de fenêtre ce bloc n'occupe que
          344 px — la ligne débordait du cadre et le nom de l'application se
          réduisait à « c… ». La fenêtre, elle, faisait 1024 : n'importe quel
          seuil `sm:` l'aurait laissée passer.

          Sous le seuil la ligne se plie en deux au lieu de tronquer. On ne
          cache aucune information : un tableau de bord étroit reste un tableau
          de bord, il est seulement plus haut.
        */
        <div className="@container">
          <ul className="divide-line divide-y">
            {recent.map((item) => {
              const duration = durations.get(item.id) ?? null;
              return (
                <li
                  key={item.id}
                  className="flex flex-col gap-1 px-5 py-2.5 text-[0.8125rem] @md:flex-row @md:items-center @md:gap-3"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-3">
                    <Led tone={DEPLOYMENT_TONE[item.status] ?? 'idle'} />
                    <Link
                      href={`/deployments/${item.id}`}
                      className="text-ink min-w-0 flex-1 truncate font-mono underline-offset-4 hover:underline"
                    >
                      {item.applicationSlug}
                      <span className="text-ink-faint"> v{item.version}</span>
                    </Link>
                  </span>

                  {/*
                    `flex-wrap` et pas de largeur fixe sur l'horodatage tant
                    qu'on est plié : le badge « rollback effectué » est le plus
                    large de la série et débordait le cadre de quelques pixels.
                    La largeur fixe ne revient qu'au-dessus du seuil, là où elle
                    sert à aligner la colonne.
                  */}
                  <span className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 pl-[22px] @md:flex-nowrap @md:pl-0">
                    {/* La durée, dessinée puis chiffrée. Un pipeline qui n'a pas
                        fini n'a pas de durée : on n'invente pas de barre pour lui. */}
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="bg-surface-3 relative h-1 w-10 overflow-hidden rounded-full">
                        {duration === null ? null : (
                          <span
                            className="bg-signal absolute inset-y-0 left-0 rounded-full"
                            style={{ width: `${Math.max(4, (duration / longest) * 100)}%` }}
                          />
                        )}
                      </span>
                      <span className="text-ink-faint w-9 text-right font-mono text-[0.6875rem] tabular-nums">
                        {duration === null ? '—' : `${duration}s`}
                      </span>
                    </span>

                    <DeploymentStatusBadge status={item.status} />
                    <span className="text-ink-faint shrink-0 text-xs whitespace-nowrap tabular-nums @md:w-20 @md:text-right">
                      {since(item.finishedAt ?? item.createdAt) ?? ''}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>

          {chronicle && chronicle.weaknesses.length > 0 ? (
            <div className="border-line border-t px-5 py-2.5">
              <p className="text-ink-faint text-[0.6875rem]">
                Sur {CHRONICLE_DAYS} jours, l&apos;étape qui casse est{' '}
                {chronicle.weaknesses.map((weakness, index) => (
                  <span key={weakness.key}>
                    {index > 0 ? ', ' : ''}
                    <span className="text-ink-muted">« {weakness.label} »</span> ({weakness.failed}{' '}
                    échec{weakness.failed > 1 ? 's' : ''} sur {weakness.decided})
                  </span>
                ))}
                .
              </p>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/**
 * La ligne sous le compteur de cibles — elle doit expliquer l'écart, pas le
 * commenter. « preflight au vert » ne disait rien quand le compte était
 * incomplet, ce qui est précisément le moment où on lit cette ligne.
 */
function targetsHint({
  canReadTargets,
  targetsDown,
  targetsUntested,
}: {
  canReadTargets: boolean;
  targetsDown: number;
  targetsUntested: number;
}): string {
  if (!canReadTargets) return 'accès restreint';

  const parts: string[] = [];
  if (targetsDown > 0) parts.push(`${targetsDown} en défaut`);
  if (targetsUntested > 0) {
    parts.push(`${targetsUntested} jamais testée${targetsUntested > 1 ? 's' : ''}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'preflight au vert';
}

/**
 * Rassemble les anomalies des sources qui peuvent en produire.
 *
 * Une même panne ne doit apparaître qu'une fois : une cible injoignable rend
 * ses applications injoignables, et lister les deux ferait croire à deux
 * incidents. Les cibles muettes sont donc relevées d'abord, et leurs
 * applications écartées ensuite.
 */
function collectAttention({
  targets,
  running,
  monitors,
  recent,
  chronicle,
  posture,
}: {
  targets: readonly PublicTarget[];
  running: Awaited<ReturnType<typeof listSupervisedApps>>;
  monitors: Awaited<ReturnType<typeof listMonitors>>;
  recent: readonly DeploymentSummary[];
  chronicle: DeploymentPulse | null;
  posture: ScanPosture | null;
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  const mute = new Set<string>();
  for (const target of targets) {
    if (target.status === 'ok' || target.status === 'unknown') continue;
    mute.add(target.name);
    items.push({
      subject: target.name,
      detail:
        target.status === 'unreachable'
          ? `Machine injoignable — ${target.host}. Les applications qu'elle porte ne peuvent plus être ni supervisées, ni mises à jour.`
          : `Preflight dégradé sur ${target.host}. Un déploiement peut échouer sans que la cause soit visible.`,
      severity: target.status === 'unreachable' ? 'danger' : 'warn',
      href: `/targets/${target.id}`,
      action: 'Diagnostiquer',
    });
  }

  for (const app of running) {
    if (mute.has(app.targetName)) continue;

    if (app.healthStatus === 'unreachable' || app.healthStatus === 'unhealthy') {
      items.push({
        subject: `${app.applicationSlug}@${app.targetName}`,
        detail:
          app.healthStatus === 'unreachable'
            ? "L'application ne répond plus à sa sonde de santé."
            : 'La sonde de santé répond, mais pas comme attendu.',
        severity: app.healthStatus === 'unreachable' ? 'danger' : 'warn',
        href: `/apps/${app.id}`,
        action: 'Voir les logs',
      });
      continue;
    }

    if (app.lastFailedUpdate) {
      items.push({
        subject: `${app.applicationSlug}@${app.targetName}`,
        detail:
          `La mise à jour en v${app.lastFailedUpdate.version} a échoué à l'étape ` +
          `« ${app.lastFailedUpdate.failedStep ?? 'inconnue'} ». ` +
          (app.lastFailedUpdate.mayHaveReplacedServices
            ? 'Elle avait commencé à remplacer les conteneurs : vérifiez ce qui tourne.'
            : 'La version précédente tourne toujours.'),
        severity: 'warn',
        href: `/deployments/${app.lastFailedUpdate.deploymentId}`,
        action: 'Voir la trace',
      });
    }
  }

  for (const monitor of monitors) {
    if (!monitor.enabled) continue;
    if (monitor.status !== 'unreachable' && monitor.status !== 'unhealthy') continue;
    items.push({
      subject: monitor.name,
      detail:
        monitor.status === 'unreachable'
          ? 'La sonde ne joint plus sa cible depuis le panel.'
          : 'La sonde joint sa cible, mais la réponse ne correspond pas à ce qui est attendu.',
      severity: monitor.status === 'unreachable' ? 'danger' : 'warn',
      href: `/monitors/${monitor.id}`,
      action: 'Voir la sonde',
    });
  }

  // Un déploiement raté d'une application qui tourne encore est déjà relevé
  // ci-dessus, avec plus de contexte. On ne garde ici que les échecs orphelins.
  const covered = new Set(running.map((app) => app.lastFailedUpdate?.deploymentId).filter(Boolean));
  for (const item of recent) {
    if (item.status !== 'failed' || covered.has(item.id)) continue;
    items.push({
      subject: `${item.applicationSlug} v${item.version}`,
      detail: `Déploiement échoué sur ${item.targetName}${item.failedStep ? ` à l'étape « ${item.failedStep} »` : ''}.`,
      severity: 'danger',
      href: `/deployments/${item.id}`,
      action: 'Voir la trace',
    });
  }

  /*
    Un repli n'est pas un échec — le garde-fou a fait son travail — mais c'est
    une version qu'on a voulu livrer et qui n'a pas tenu. Elle mérite d'être vue
    une fois, pas de disparaître dans un compteur. On ne relève que les replis
    de la fenêtre courte : celui d'il y a six jours a déjà été traité ou ne le
    sera jamais, et l'écran des anomalies n'est pas un journal.
  */
  if (chronicle) {
    const recentEnough = Date.now() - 24 * 3600 * 1000;
    for (const event of chronicle.events) {
      if (event.status !== 'rolled_back') continue;
      if (Date.parse(event.at) < recentEnough) continue;
      items.push({
        subject: `${event.applicationSlug} v${event.version}`,
        detail:
          `Déploiement replié sur ${event.targetName}` +
          (event.failedStep ? ` — l'étape « ${event.failedStep} » a refusé la version` : '') +
          '. La version précédente a été remise en place automatiquement.',
        severity: 'warn',
        href: `/deployments/${event.id}`,
        action: 'Voir la trace',
      });
    }
  }

  /*
    Le seul endroit du produit où un chiffre rassurant en recouvre un qui ne
    l'est pas : une analyse conclut « conforme » parce que le seuil de blocage
    est réglé sur « aucun », pendant qu'elle rapporte des failles critiques.
    Rien dans l'écran ne le disait — on lisait « scan : conforme » et on passait.
  */
  if (posture && posture.passedWithSevere > 0 && posture.bySeverity.critical > 0) {
    items.push({
      subject: 'Analyses de sécurité',
      detail:
        `${posture.passedWithSevere} analyse${posture.passedWithSevere > 1 ? 's ont' : ' a'} conclu ` +
        `« conforme » tout en rapportant ${posture.bySeverity.critical} faille${posture.bySeverity.critical > 1 ? 's' : ''} ` +
        `critique${posture.bySeverity.critical > 1 ? 's' : ''} et ${posture.bySeverity.high} de gravité haute. ` +
        `Le seuil de blocage est sur « aucun » : le verdict ne bloque rien.`,
      severity: 'warn',
      href: '/admin/settings',
      action: 'Régler le seuil',
    });
  }

  return items;
}
