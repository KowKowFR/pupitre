import { DEPLOYMENT_STEPS, type DeploymentStatus, type DeploymentStepKey } from '@pupitre/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { applications, targets } from './schema/infra.js';
import { deployments, deploymentSteps } from './schema/deployments.js';
import { monitorChecks, monitors } from './schema/monitors.js';
import { auditLogs } from './schema/ops.js';
import { findings, scanRuns } from './schema/security.js';
import type { HistoryPoint, TargetHistory } from './target-metrics.js';

/**
 * Agrégations du tableau de bord — la dimension temporelle.
 *
 * ── Pourquoi un module à part ───────────────────────────────────────────────
 * Les lectures existantes répondent toutes à « quel est l'état de X *en ce
 * moment* ». Le tableau de bord pose l'autre question : « qu'est-ce qui s'est
 * passé depuis hier ». Ce sont des requêtes bucketisées, transverses à tous les
 * domaines, et qui n'appartiennent à aucun d'eux. Les poser dans `monitors.ts`
 * ou `deployments.ts` y ferait entrer une préoccupation d'écran.
 *
 * ── La règle qui gouverne tout ce fichier ───────────────────────────────────
 * **Aucune série ne sort d'ici sans son dénominateur.** Chaque seau porte son
 * nombre de relevés, et un seau sans relevé sort avec `samples: 0` et une
 * valeur `null` — jamais un zéro. Un tableau de bord qui dessine un zéro là où
 * il n'a rien mesuré affirme que tout allait bien à un moment qu'il n'a pas
 * regardé, et c'est exactement le mensonge qu'on veut rendre impossible.
 *
 * La conséquence pour l'appelant : `Coverage` est fait pour être *affiché*, pas
 * seulement consulté. Un écran qui reçoit `covered: 2` sur `buckets: 24` doit
 * dire « deux heures de relevés sur vingt-quatre », pas tracer une courbe plate.
 */

// ─── le gabarit temporel ──────────────────────────────────────────────────────

/**
 * La fenêtre et son découpage. Les bornes sont **alignées sur l'époque**, comme
 * le fait déjà `targetHistories` : deux séries calculées séparément tombent
 * ainsi sur exactement les mêmes seaux, et peuvent partager un axe. C'est la
 * seule raison pour laquelle le tableau de bord peut superposer des sondes, une
 * charge machine et des déploiements sans les décaler d'une demi-heure.
 */
export type PulseWindow = {
  hours: number;
  buckets: number;
  bucketSeconds: number;
  /** Début du premier seau, ISO. */
  from: string;
  /** Fin du dernier seau, ISO. */
  to: string;
};

/**
 * Ce que la fenêtre contient réellement — le contraire d'une promesse.
 *
 * `buckets` est ce qu'on a demandé, `covered` ce qu'on a mesuré. L'écart entre
 * les deux est l'information la plus importante d'un jeu de données maigre.
 */
export type Coverage = {
  buckets: number;
  /** Seaux portant au moins un relevé. */
  covered: number;
  /** Relevés au total sur la fenêtre. */
  samples: number;
  /** Premier et dernier relevé réels — les bornes de ce qu'on sait. */
  firstAt: string | null;
  lastAt: string | null;
};

/**
 * Fabrique le gabarit. `now` est injectable pour que le calcul reste
 * déterministe à l'essai ; en service c'est l'horloge du panel.
 *
 * Le dernier seau est celui qui **contient** l'instant présent, pas celui qui
 * le précède : sinon la mesure prise il y a trente secondes n'aurait nulle part
 * où se poser, et le tableau de bord paraîtrait en retard d'une heure.
 */
export function pulseWindow(hours: number, buckets: number, now = new Date()): PulseWindow {
  const bucketSeconds = Math.max(60, Math.round((hours * 3600) / buckets));
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const lastStart = Math.floor(nowSeconds / bucketSeconds) * bucketSeconds;
  const firstStart = lastStart - (buckets - 1) * bucketSeconds;
  return {
    hours,
    buckets,
    bucketSeconds,
    from: new Date(firstStart * 1000).toISOString(),
    to: new Date((lastStart + bucketSeconds) * 1000).toISOString(),
  };
}

/** Les débuts de seau, du plus ancien au plus récent. */
function bucketStarts(window: PulseWindow): number[] {
  const first = Math.floor(Date.parse(window.from) / 1000);
  return Array.from({ length: window.buckets }, (_, i) => first + i * window.bucketSeconds);
}

/**
 * L'indice du seau qui accueille un instant, ou `null` s'il tombe hors gabarit.
 *
 * Le pincement final n'est pas de la superstition : le gabarit est calculé avec
 * l'horloge du panel et les lignes avec `now()` côté Postgres. À la bascule
 * d'un seau, quelques millisecondes d'écart suffiraient à faire disparaître la
 * mesure la plus récente — celle qu'on regarde en premier.
 */
function bucketIndex(window: PulseWindow, at: Date): number | null {
  const first = Math.floor(Date.parse(window.from) / 1000);
  const seconds = Math.floor(at.getTime() / 1000);
  const index = Math.floor((seconds - first) / window.bucketSeconds);
  if (index < 0) return null;
  return index >= window.buckets ? window.buckets - 1 : index;
}

function coverageOf(
  points: readonly { at: string; samples: number }[],
  window: PulseWindow,
  firstAt: string | null,
  lastAt: string | null,
): Coverage {
  let covered = 0;
  let samples = 0;
  for (const point of points) {
    if (point.samples > 0) covered += 1;
    samples += point.samples;
  }
  return { buckets: window.buckets, covered, samples, firstAt, lastAt };
}

/**
 * L'expression de seau, en secondes d'époque.
 *
 * `sql.raw` et non un paramètre lié, pour la raison déjà documentée dans
 * `targetHistories` : la même expression apparaît dans le SELECT et dans le
 * GROUP BY, et Postgres ne reconnaît pas deux placeholders comme une seule
 * expression. `bucketSeconds` sort d'un `Math.round` sur des entiers, jamais
 * d'une chaîne : aucune injection possible.
 */
function bucketExpression(column: unknown, bucketSeconds: number) {
  const seconds = sql.raw(String(bucketSeconds));
  return sql<string>`to_timestamp(floor(extract(epoch from ${column}) / ${seconds}) * ${seconds})`;
}

// ─── pouls des sondes ─────────────────────────────────────────────────────────

export type MonitorPulsePoint = {
  at: string;
  /** Mesures prises dans le seau. Zéro veut dire « on n'a pas regardé ». */
  samples: number;
  healthy: number;
  latencyAvgMs: number | null;
  latencyMaxMs: number | null;
};

export type MonitorPulse = {
  window: PulseWindow;
  coverage: Coverage;
  points: MonitorPulsePoint[];
  /** Sondes actives ayant produit au moins une mesure sur la fenêtre. */
  monitorsSeen: number;
};

/**
 * La disponibilité mesurée, seau par seau, toutes sondes confondues.
 *
 * ── Pourquoi le seau horaire, et pas plus fin ───────────────────────────────
 * La cadence réelle des sondes n'est pas régulière : elle dépend du planificateur,
 * qui peut avoir été arrêté. Sur les données de cette instance on observe une
 * mesure par heure pendant une demi-journée, puis cinquante par heure. Un seau
 * de dix minutes rendrait la première moitié presque entièrement vide et
 * donnerait à croire à une panne de sonde là où il n'y a qu'un rythme lent.
 * Le seau horaire est le plus fin qui garde une chance d'être peuplé — et le
 * compte de mesures qui l'accompagne dit le reste.
 *
 * Le taux n'est **pas** calculé ici. `healthy / samples` sur un seau à une seule
 * mesure vaut 0 % ou 100 % et rien d'autre ; c'est à l'écran de décider s'il
 * dessine ça comme une valeur ou comme une incertitude, et il ne peut le faire
 * que s'il voit le dénominateur.
 */
export async function monitorPulse(
  hours = 24,
  buckets = 24,
  db: Database = getDb(),
): Promise<MonitorPulse> {
  const window = pulseWindow(hours, buckets);
  const bucket = bucketExpression(monitorChecks.checkedAt, window.bucketSeconds);

  const rows = await db
    .select({
      at: bucket,
      samples: sql<number>`count(*)::int`,
      healthy: sql<number>`count(*) filter (where ${monitorChecks.outcome} = 'healthy')::int`,
      latencyAvgMs: sql<number | null>`round(avg(${monitorChecks.latencyMs}))::int`,
      latencyMaxMs: sql<number | null>`max(${monitorChecks.latencyMs})::int`,
      monitorsSeen: sql<number>`count(distinct ${monitorChecks.monitorId})::int`,
      firstAt: sql<string>`min(${monitorChecks.checkedAt})`,
      lastAt: sql<string>`max(${monitorChecks.checkedAt})`,
    })
    .from(monitorChecks)
    .innerJoin(monitors, eq(monitors.id, monitorChecks.monitorId))
    .where(
      and(
        eq(monitors.enabled, true),
        sql`${monitorChecks.checkedAt} >= now() - make_interval(hours => ${hours})`,
      ),
    )
    .groupBy(bucket)
    .orderBy(asc(bucket));

  const points: MonitorPulsePoint[] = bucketStarts(window).map((start) => ({
    at: new Date(start * 1000).toISOString(),
    samples: 0,
    healthy: 0,
    latencyAvgMs: null,
    latencyMaxMs: null,
  }));

  const seen = new Set<number>();
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let monitorsSeen = 0;

  for (const row of rows) {
    const index = bucketIndex(window, new Date(row.at));
    if (index === null) continue;
    const point = points[index];
    if (!point) continue;
    point.samples += row.samples;
    point.healthy += row.healthy;
    point.latencyAvgMs = row.latencyAvgMs;
    point.latencyMaxMs = row.latencyMaxMs;
    seen.add(index);
    monitorsSeen = Math.max(monitorsSeen, row.monitorsSeen);
    const rowFirst = new Date(row.firstAt).toISOString();
    const rowLast = new Date(row.lastAt).toISOString();
    if (firstAt === null || rowFirst < firstAt) firstAt = rowFirst;
    if (lastAt === null || rowLast > lastAt) lastAt = rowLast;
  }

  return {
    window,
    coverage: coverageOf(points, window, firstAt, lastAt),
    points,
    monitorsSeen,
  };
}

// ─── pouls de l'activité ──────────────────────────────────────────────────────

export type ActivityPoint = { at: string; samples: number; denied: number };

export type ActivityPulse = {
  window: PulseWindow;
  coverage: Coverage;
  points: ActivityPoint[];
  total: number;
  /** Refus de permission — la seule ligne d'audit qui appelle une décision. */
  denied: number;
};

/**
 * Le volume d'actions journalisées, seau par seau.
 *
 * On isole `permission.denied` parce que c'est la seule action d'audit qui dit
 * quelque chose sans qu'on ouvre le journal : quelqu'un a demandé ce qu'il n'a
 * pas le droit de faire. Le reste du volume est une mesure d'agitation, utile
 * pour situer un incident dans le temps, jamais pour juger.
 */
export async function activityPulse(
  hours = 24,
  buckets = 24,
  db: Database = getDb(),
): Promise<ActivityPulse> {
  const window = pulseWindow(hours, buckets);
  const bucket = bucketExpression(auditLogs.createdAt, window.bucketSeconds);

  const rows = await db
    .select({
      at: bucket,
      samples: sql<number>`count(*)::int`,
      denied: sql<number>`count(*) filter (where ${auditLogs.action} = 'permission.denied')::int`,
      firstAt: sql<string>`min(${auditLogs.createdAt})`,
      lastAt: sql<string>`max(${auditLogs.createdAt})`,
    })
    .from(auditLogs)
    .where(sql`${auditLogs.createdAt} >= now() - make_interval(hours => ${hours})`)
    .groupBy(bucket)
    .orderBy(asc(bucket));

  const points: ActivityPoint[] = bucketStarts(window).map((start) => ({
    at: new Date(start * 1000).toISOString(),
    samples: 0,
    denied: 0,
  }));

  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let total = 0;
  let denied = 0;

  for (const row of rows) {
    const index = bucketIndex(window, new Date(row.at));
    if (index === null) continue;
    const point = points[index];
    if (!point) continue;
    point.samples += row.samples;
    point.denied += row.denied;
    total += row.samples;
    denied += row.denied;
    const rowFirst = new Date(row.firstAt).toISOString();
    const rowLast = new Date(row.lastAt).toISOString();
    if (firstAt === null || rowFirst < firstAt) firstAt = rowFirst;
    if (lastAt === null || rowLast > lastAt) lastAt = rowLast;
  }

  return { window, coverage: coverageOf(points, window, firstAt, lastAt), points, total, denied };
}

// ─── chronique des déploiements ───────────────────────────────────────────────

export type DeploymentEvent = {
  id: string;
  /** Numéro de run, global à l'instance. */
  number: number;
  at: string;
  finishedAt: string | null;
  status: DeploymentStatus;
  applicationSlug: string;
  targetName: string;
  runtime: 'docker' | 'k3s';
  version: number;
  /** Durée réelle du pipeline, ou `null` s'il n'est pas terminé. */
  durationSeconds: number | null;
  failedStep: string | null;
};

/** Une étape du pipeline et la part de fois où elle casse. */
export type StepWeakness = {
  key: DeploymentStepKey | string;
  label: string;
  failed: number;
  /** Exécutions de l'étape qui ont abouti à un verdict — `skipped` exclu. */
  decided: number;
};

export type DeploymentPulse = {
  days: number;
  events: DeploymentEvent[];
  tallies: {
    total: number;
    succeeded: number;
    failed: number;
    rolledBack: number;
    destroyed: number;
    inFlight: number;
  };
  /** Étapes ayant échoué au moins une fois, la plus fragile d'abord. */
  weaknesses: StepWeakness[];
  /** Durée médiane d'un pipeline terminé, en secondes. `null` sous trois mesures. */
  medianDurationSeconds: number | null;
};

const STEP_LABELS = new Map<string, string>(
  DEPLOYMENT_STEPS.map((step) => [step.key, step.label]),
);

/**
 * Les déploiements de la fenêtre, un par un, plus ce qu'on peut en dire.
 *
 * ── Pourquoi des événements et pas un taux ──────────────────────────────────
 * La tentation est de tracer « taux de réussite par jour ». Sur un parc qui
 * déploie huit fois en trente-six heures, ce taux vaut 100 % ou 50 % et bouge
 * d'un quart à chaque déploiement : c'est du bruit tracé comme une tendance.
 * Une chronique d'événements posés sur un axe de temps dit la même chose sans
 * rien inventer — et elle reste juste le jour où il y en aura mille.
 *
 * `medianDurationSeconds` sort `null` sous trois pipelines terminés, pour la
 * même raison : une médiane sur deux valeurs est une des deux valeurs.
 *
 * ── Pourquoi `rolled_back` compte à part ────────────────────────────────────
 * Un retour arrière n'est ni une réussite ni un échec de déploiement : le
 * pipeline a fait exactement ce qu'on lui demandait — constater que la nouvelle
 * version ne répondait pas, et remettre l'ancienne. Le fondre dans les échecs
 * effacerait le fait que le garde-fou a fonctionné ; le fondre dans les
 * réussites effacerait le fait que la version livrée était mauvaise.
 */
export async function deploymentPulse(days = 7, db: Database = getDb()): Promise<DeploymentPulse> {
  const rows = await db
    .select({
      id: deployments.id,
      number: deployments.number,
      at: deployments.createdAt,
      startedAt: deployments.startedAt,
      finishedAt: deployments.finishedAt,
      status: deployments.status,
      applicationSlug: applications.slug,
      targetName: targets.name,
      runtime: deployments.runtime,
      version: deployments.version,
      failedStep: deployments.failedStep,
    })
    .from(deployments)
    .innerJoin(applications, eq(applications.id, deployments.applicationId))
    .innerJoin(targets, eq(targets.id, deployments.targetId))
    .where(sql`${deployments.createdAt} >= now() - make_interval(days => ${days})`)
    .orderBy(asc(deployments.createdAt));

  const events: DeploymentEvent[] = rows.map((row) => ({
    id: row.id,
    number: row.number,
    at: row.at.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    status: row.status,
    applicationSlug: row.applicationSlug,
    targetName: row.targetName,
    runtime: row.runtime,
    version: row.version,
    durationSeconds:
      row.startedAt && row.finishedAt
        ? Math.max(0, Math.round((row.finishedAt.getTime() - row.startedAt.getTime()) / 1000))
        : null,
    failedStep: row.failedStep,
  }));

  const tallies = {
    total: events.length,
    succeeded: events.filter((event) => event.status === 'success').length,
    failed: events.filter((event) => event.status === 'failed').length,
    rolledBack: events.filter((event) => event.status === 'rolled_back').length,
    destroyed: events.filter((event) => event.status === 'destroyed').length,
    inFlight: events.filter((event) => event.status === 'pending' || event.status === 'running')
      .length,
  };

  const ids = rows.map((row) => row.id);
  const weaknesses: StepWeakness[] = [];

  if (ids.length > 0) {
    const stepRows = await db
      .select({
        key: deploymentSteps.key,
        failed: sql<number>`count(*) filter (where ${deploymentSteps.status} = 'failed')::int`,
        decided: sql<number>`count(*) filter (where ${deploymentSteps.status} in ('failed', 'success'))::int`,
      })
      .from(deploymentSteps)
      .where(inArray(deploymentSteps.deploymentId, ids))
      .groupBy(deploymentSteps.key);

    for (const row of stepRows) {
      if (row.failed === 0) continue;
      weaknesses.push({
        key: row.key,
        label: STEP_LABELS.get(row.key) ?? row.key,
        failed: row.failed,
        decided: row.decided,
      });
    }
    weaknesses.sort((a, b) => b.failed - a.failed || a.key.localeCompare(b.key));
  }

  const durations = events
    .map((event) => event.durationSeconds)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  return {
    days,
    events,
    tallies,
    weaknesses,
    medianDurationSeconds:
      durations.length >= 3 ? (durations[Math.floor(durations.length / 2)] ?? null) : null,
  };
}

// ─── posture de sécurité ──────────────────────────────────────────────────────

export type ScanPosture = {
  days: number;
  runs: number;
  lastAt: string | null;
  bySeverity: { critical: number; high: number; medium: number; low: number; other: number };
  /** Parmi les critiques, celles qu'une version corrige : ce qu'on peut régler tout de suite. */
  fixableCritical: number;
  /**
   * Exécutions déclarées « pass » qui portaient pourtant du critique ou du haut,
   * parce que la porte (`fail_on`) était réglée sur `none`.
   *
   * Ce n'est pas une curiosité : c'est le seul endroit du produit où un chiffre
   * rassurant recouvre un fait qui ne l'est pas. Le tableau de bord doit le dire.
   */
  passedWithSevere: number;
};

/** L'état des analyses de la fenêtre, et si leur verdict veut dire quelque chose. */
export async function scanPosture(days = 7, db: Database = getDb()): Promise<ScanPosture> {
  const within = sql`${scanRuns.createdAt} >= now() - make_interval(days => ${days})`;

  const [totals] = await db
    .select({
      runs: sql<number>`count(*)::int`,
      lastAt: sql<string | null>`max(${scanRuns.createdAt})`,
    })
    .from(scanRuns)
    .where(within);

  const severityRows = await db
    .select({
      severity: findings.severity,
      value: sql<number>`count(*)::int`,
      fixable: sql<number>`count(*) filter (where coalesce(${findings.fixedVersion}, '') <> '')::int`,
    })
    .from(findings)
    .innerJoin(scanRuns, eq(scanRuns.id, findings.scanRunId))
    .where(within)
    .groupBy(findings.severity);

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, other: 0 };
  let fixableCritical = 0;
  for (const row of severityRows) {
    if (row.severity === 'critical') fixableCritical += row.fixable;
    if (row.severity === 'critical') bySeverity.critical += row.value;
    else if (row.severity === 'high') bySeverity.high += row.value;
    else if (row.severity === 'medium') bySeverity.medium += row.value;
    else if (row.severity === 'low') bySeverity.low += row.value;
    else bySeverity.other += row.value;
  }

  // Un `count(distinct)` plutôt qu'un sous-select : une exécution portant trente
  // failles critiques reste une exécution, pas trente.
  const [gate] = await db
    .select({ value: sql<number>`count(distinct ${scanRuns.id})::int` })
    .from(scanRuns)
    .innerJoin(findings, eq(findings.scanRunId, scanRuns.id))
    .where(
      and(
        within,
        eq(scanRuns.verdict, 'pass'),
        eq(scanRuns.failOn, 'none'),
        inArray(findings.severity, ['critical', 'high']),
      ),
    );

  return {
    days,
    runs: totals?.runs ?? 0,
    lastAt: totals?.lastAt ? new Date(totals.lastAt).toISOString() : null,
    bySeverity,
    fixableCritical,
    passedWithSevere: gate?.value ?? 0,
  };
}

// ─── repli du parc sur un seul axe ────────────────────────────────────────────

export type FleetPoint = {
  at: string;
  /** Relevés pris sur l'ensemble du parc dans ce seau. */
  samples: number;
  /** Machines ayant répondu au moins une fois dans ce seau. */
  targets: number;
  loadPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
};

export type FleetPulse = { window: PulseWindow; coverage: Coverage; points: FleetPoint[] };

/**
 * Replie les historiques par machine en une seule série « pire du parc ».
 *
 * Une fonction pure, et volontairement pas une requête : `targetHistories` fait
 * déjà exactement le bon travail en une requête indexée, et le tableau de bord
 * a de toute façon besoin du détail par machine pour sa liste. Ajouter un second
 * SQL pour recalculer le maximum de ce qu'on tient déjà en mémoire coûterait un
 * aller-retour et une chance de plus de diverger.
 *
 * `max` et non `avg`, pour la raison écrite dans `targetHistories` : on regarde
 * une saturation, et la moyenne du parc noie la machine qui étouffe.
 */
export function foldFleet(
  histories: Iterable<TargetHistory>,
  window: PulseWindow,
): FleetPulse {
  const points: FleetPoint[] = bucketStarts(window).map((start) => ({
    at: new Date(start * 1000).toISOString(),
    samples: 0,
    targets: 0,
    loadPercent: null,
    memoryPercent: null,
    diskPercent: null,
  }));

  const worst = (current: number | null, candidate: number | null): number | null =>
    candidate === null ? current : current === null ? candidate : Math.max(current, candidate);

  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (const history of histories) {
    for (const point of history.points as readonly HistoryPoint[]) {
      const index = bucketIndex(window, new Date(point.at));
      if (index === null) continue;
      const slot = points[index];
      if (!slot) continue;
      slot.samples += point.samples;
      if (point.samples > 0) slot.targets += 1;
      slot.loadPercent = worst(slot.loadPercent, point.loadPercent);
      slot.memoryPercent = worst(slot.memoryPercent, point.memoryPercent);
      slot.diskPercent = worst(slot.diskPercent, point.diskPercent);
      if (firstAt === null || point.at < firstAt) firstAt = point.at;
      if (lastAt === null || point.at > lastAt) lastAt = point.at;
    }
  }

  return { window, coverage: coverageOf(points, window, firstAt, lastAt), points };
}
