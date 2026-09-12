import 'server-only';
import {
  MONITOR_SPARKLINE_POINTS,
  formatUptime,
  isMonitorType,
  monitorTargetLink,
  monitorTypeDefinition,
  parseCidrList,
  type CheckMetrics,
  type Cidr,
  type MonitorType,
  type UptimeWindow,
} from '@pupitre/core';
import { SsrfBlockedError, resolveUrlGuarded } from '@pupitre/core/probe';
import {
  listChecks,
  listIncidents,
  monitorTarget,
  uptimeWindows,
  type Monitor,
  type MonitorCheck,
  type MonitorIncident,
} from '@pupitre/db';
import { HttpError } from './errors';
import { getEnv } from './env';

/**
 * Ce que l'écran de supervision consomme, et la garde SSRF côté panel.
 *
 * Aucune projection ne connaît de type de sonde : la cible, le lien et les
 * mesures viennent du catalogue. Ajouter un type n'oblige pas à repasser ici.
 */

let cachedCidrs: Cidr[] | null = null;

export function allowedCidrs(): readonly Cidr[] {
  cachedCidrs ??= parseCidrList(getEnv().MONITOR_ALLOWED_CIDRS);
  return cachedCidrs;
}

/**
 * Refuse une cible interdite **à la création**, pas seulement au moment de
 * sonder.
 *
 * Laisser entrer une cible interne pour la refuser silencieusement toutes les
 * minutes serait un piège : l'opérateur verrait une sonde éternellement en
 * échec sans comprendre pourquoi. Le worker refait le contrôle de son côté — à
 * chaque saut de redirection — parce qu'un DNS peut changer entre les deux, et
 * parce qu'une garde qui ne tient qu'à l'interface n'en est pas une.
 */
export async function assertUrlAllowed(url: string, field = 'url'): Promise<void> {
  try {
    await resolveUrlGuarded(url, allowedCidrs());
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      throw new HttpError(422, 'url_not_allowed', error.reason, { field, url });
    }
    throw error;
  }
}

/**
 * Contrôle la cible d'une sonde, quel que soit son type.
 *
 * La cible est décrite par le catalogue (`linkFor`), pas lue dans un champ
 * connu d'avance : une sonde HTTP porte une URL, une sonde TLS un hôte et un
 * port, et une sonde qui viendra plus tard portera autre chose.
 */
export async function assertConfigAllowed(type: MonitorType, config: unknown): Promise<void> {
  const link = monitorTargetLink(type, config);
  if (link === null) return;
  await assertUrlAllowed(link, 'config');
}

// ─── projections d'écran ──────────────────────────────────────────────────────

export type MonitorCheckView = {
  id: string;
  checkedAt: string;
  outcome: 'healthy' | 'unhealthy' | 'unreachable';
  latencyMs: number | null;
  detail: string | null;
  metrics: CheckMetrics;
};

export type MonitorIncidentView = {
  id: string;
  startedAt: string;
  resolvedAt: string | null;
  durationSeconds: number | null;
  cause: 'healthy' | 'unhealthy' | 'unreachable' | 'unknown';
  detail: string | null;
  metrics: CheckMetrics;
  failureCount: number;
  alerted: boolean;
  alertError: string | null;
  resolveAlerted: boolean;
  resolveAlertError: string | null;
};

export type UptimeView = UptimeWindow & { label: string };

export type MonitorView = {
  id: string;
  name: string;
  type: MonitorType;
  typeLabel: string;
  /** La cible en une ligne — une URL pour HTTP, un hôte:port pour TLS. */
  target: string;
  targetLink: string | null;
  config: Record<string, unknown>;
  intervalSeconds: number;
  failureThreshold: number;
  recoveryThreshold: number;
  enabled: boolean;
  pausedReason: string | null;
  applicationId: string | null;
  /** Jamais l'URL : c'est le secret. Seule sa présence est publique. */
  hasWebhook: boolean;
  status: 'unknown' | 'healthy' | 'unhealthy' | 'unreachable';
  lastOutcome: 'unknown' | 'healthy' | 'unhealthy' | 'unreachable' | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastCheckedAt: string | null;
  lastLatencyMs: number | null;
  lastDetail: string | null;
  lastMetrics: CheckMetrics;
  nextCheckAt: string;
  /** `true` tant qu'aucune mesure n'est passée : l'écran le dit plutôt que 0 %. */
  neverRan: boolean;
  uptime24h: UptimeView;
  uptime7d: UptimeView;
  /** Mesures récentes, de la plus ancienne à la plus récente. */
  recent: Array<{ at: string; latencyMs: number | null; outcome: string }>;
  openIncidentSince: string | null;
  createdAt: string;
};

function view(window: UptimeWindow): UptimeView {
  return { ...window, label: formatUptime(window) };
}

export function toCheckView(check: MonitorCheck): MonitorCheckView {
  return {
    id: check.id,
    checkedAt: check.checkedAt.toISOString(),
    outcome: check.outcome === 'unknown' ? 'unreachable' : check.outcome,
    latencyMs: check.latencyMs,
    detail: check.detail,
    metrics: check.metrics ?? {},
  };
}

export function toIncidentView(incident: MonitorIncident): MonitorIncidentView {
  const durationSeconds = incident.resolvedAt
    ? Math.max(0, Math.round((incident.resolvedAt.getTime() - incident.startedAt.getTime()) / 1000))
    : null;
  return {
    id: incident.id,
    startedAt: incident.startedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    durationSeconds,
    cause: incident.cause,
    detail: incident.detail,
    metrics: incident.metrics ?? {},
    failureCount: incident.failureCount,
    alerted: incident.alertSentAt !== null,
    alertError: incident.alertError,
    resolveAlerted: incident.resolveAlertSentAt !== null,
    resolveAlertError: incident.resolveAlertError,
  };
}

/**
 * Une liste de sondes, complète pour l'écran.
 *
 * Les deux fenêtres de disponibilité sont calculées en **deux requêtes
 * groupées**, pas en deux requêtes par sonde : vingt sondes, c'est deux
 * requêtes, pas quarante.
 */
export async function buildMonitorViews(rows: Monitor[]): Promise<MonitorView[]> {
  const ids = rows.map((row) => row.id);
  const [day, week] = await Promise.all([uptimeWindows(ids, 24), uptimeWindows(ids, 24 * 7)]);

  return Promise.all(
    rows.map(async (row) => {
      const [checks, incidents] = await Promise.all([
        listChecks(row.id, MONITOR_SPARKLINE_POINTS),
        listIncidents(row.id, 1),
      ]);
      const open = incidents.find((incident) => incident.resolvedAt === null) ?? null;
      const type: MonitorType = isMonitorType(row.type) ? row.type : 'http';
      const definition = monitorTypeDefinition(type);

      return {
        id: row.id,
        name: row.name,
        type,
        typeLabel: isMonitorType(row.type) ? definition.label : `type inconnu « ${row.type} »`,
        target: monitorTarget(row),
        targetLink: isMonitorType(row.type) ? monitorTargetLink(type, row.config) : null,
        config: row.config,
        intervalSeconds: row.intervalSeconds,
        failureThreshold: row.failureThreshold,
        recoveryThreshold: row.recoveryThreshold,
        enabled: row.enabled,
        pausedReason: row.pausedReason,
        applicationId: row.applicationId,
        hasWebhook: row.webhookUrlEncrypted !== null,
        status: row.status,
        lastOutcome: row.lastOutcome,
        consecutiveFailures: row.consecutiveFailures,
        consecutiveSuccesses: row.consecutiveSuccesses,
        lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
        lastLatencyMs: row.lastLatencyMs,
        lastDetail: row.lastDetail,
        lastMetrics: row.lastMetrics ?? {},
        nextCheckAt: row.nextCheckAt.toISOString(),
        neverRan: row.lastCheckedAt === null,
        uptime24h: view(day.get(row.id) ?? { hours: 24, samples: 0, up: 0, ratio: null }),
        uptime7d: view(week.get(row.id) ?? { hours: 168, samples: 0, up: 0, ratio: null }),
        recent: checks
          .slice()
          .reverse()
          .map((check) => ({
            at: check.checkedAt.toISOString(),
            latencyMs: check.latencyMs,
            outcome: check.outcome,
          })),
        openIncidentSince: open?.startedAt.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    }),
  );
}

/**
 * Le catalogue, sérialisé pour l'écran.
 *
 * Les schémas Zod ne traversent pas la frontière serveur/client : on n'envoie
 * que ce que le formulaire doit savoir — champs, mesures, bornes, valeurs de
 * départ. C'est ce qui permet à l'écran de se construire sans aucun
 * `if (type === 'http')`.
 */
export type MonitorTypeOption = {
  type: MonitorType;
  label: string;
  description: string;
  neverDoes: string;
  fields: ReturnType<typeof monitorTypeDefinition>['fields'];
  metrics: ReturnType<typeof monitorTypeDefinition>['metrics'];
  minIntervalSeconds: number;
  defaultIntervalSeconds: number;
  defaults: unknown;
  uptimeMeans: string;
};

export function monitorTypeOptions(types: readonly MonitorType[]): MonitorTypeOption[] {
  return types.map((type) => {
    const definition = monitorTypeDefinition(type);
    return {
      type,
      label: definition.label,
      description: definition.description,
      neverDoes: definition.neverDoes,
      fields: definition.fields,
      metrics: definition.metrics,
      minIntervalSeconds: definition.minIntervalSeconds,
      defaultIntervalSeconds: definition.defaultIntervalSeconds,
      defaults: definition.defaults,
      uptimeMeans: definition.uptimeMeans,
    };
  });
}
