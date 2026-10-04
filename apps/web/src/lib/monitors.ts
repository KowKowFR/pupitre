import 'server-only';
import {
  MONITOR_SPARKLINE_POINTS,
  describeMonitorTarget,
  formatCadence,
  formatUptime,
  isMonitorType,
  issueMessage,
  monitorTargetLink,
  monitorTypeDefinition,
  parseCidrList,
  renderMessage,
  ssrfRefusalText,
  type CheckMetrics,
  type Cidr,
  type MonitorType,
  type UiLanguage,
  type UptimeWindow,
} from '@pupitre/core';
import { SsrfBlockedError, resolveUrlGuarded } from '@pupitre/core/probe';
import {
  listChecks,
  listIncidents,
  uptimeWindows,
  type Monitor,
  type MonitorCheck,
  type MonitorConfigError,
  type MonitorIncident,
} from '@pupitre/db';
import { currentLanguage } from '@/i18n/server';
import { monitors as messages } from '@/i18n/messages/monitors';
import { HttpError, msg } from './errors';
import { getEnv } from './env';

/**
 * What the monitoring screen consumes, and the SSRF guard on the panel side.
 *
 * No projection knows a probe type: the target, the link and the measurements
 * come from the catalog. Adding a type does not require coming back here.
 */

let cachedCidrs: Cidr[] | null = null;

function allowedCidrs(): readonly Cidr[] {
  cachedCidrs ??= parseCidrList(getEnv().MONITOR_ALLOWED_CIDRS);
  return cachedCidrs;
}

/**
 * Refuses a forbidden target **at creation**, not only at probing time.
 *
 * Letting an internal target in to refuse it silently every minute would be a
 * trap: the operator would see a probe forever failing without understanding
 * why. The worker does the check again on its side — at each redirect hop —
 * because a DNS can change in between, and because a guard that only holds in
 * the interface is not one.
 */
export async function assertUrlAllowed(url: string, field = 'url'): Promise<void> {
  try {
    await resolveUrlGuarded(url, allowedCidrs());
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      // `refusal` rather than `reason`: the SSRF guard lives in `@pupitre/core`, which
      // has no instance language and therefore returns French. The refusal travels as
      // data, and it is here — the only place that speaks to someone — that it becomes
      // a sentence.
      const reason = ssrfRefusalText(error.refusal, await currentLanguage());
      throw new HttpError(422, 'url_not_allowed', reason, { field, url });
    }
    throw error;
  }
}

/**
 * A probe configuration's refusal, put into a sentence.
 *
 * `@pupitre/db` raises the refusal in separate pieces — see
 * `MonitorConfigReason`. The two routes that catch it render it from here, hence
 * the same way: a single version of the sentence for creation and for editing.
 *
 * The type's label and the cadences are rendered **right away**, in the instance's
 * language; it is the very one in which `apiRoute()` will render the template.
 */
export async function monitorConfigMessage(error: MonitorConfigError): Promise<HttpError> {
  const language: UiLanguage = await currentLanguage();
  const details = { field: error.field };
  const reason = error.reason;

  if (reason.kind === 'target') {
    return new HttpError(
      422,
      'validation_failed',
      ssrfRefusalText(reason.refusal, language),
      details,
    );
  }

  const label = monitorTypeDefinition(reason.type, language).label;

  if (reason.kind === 'schema') {
    return new HttpError(
      422,
      'validation_failed',
      msg(messages, 'error.configInvalid', {
        label,
        path: reason.path,
        issue: issueMessage({ message: reason.issue, params: reason.params }, language),
      }),
      details,
    );
  }

  return new HttpError(
    422,
    'validation_failed',
    msg(messages, 'error.intervalTooShort', {
      label,
      floor: formatCadence(reason.minSeconds, language),
      asked: formatCadence(reason.askedSeconds, language),
    }),
    details,
  );
}

/**
 * Checks a probe's target, whatever its type.
 *
 * The target is described by the catalog (`linkFor`), not read from a field known
 * in advance: an HTTP probe carries a URL, a TLS probe a host and a port, and a
 * probe coming later will carry something else.
 */
export async function assertConfigAllowed(type: MonitorType, config: unknown): Promise<void> {
  const link = monitorTargetLink(type, config);
  if (link === null) return;
  await assertUrlAllowed(link, 'config');
}

// ─── screen projections ───────────────────────────────────────────────────────

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
  /** The target in one line — a URL for HTTP, a host:port for TLS. */
  target: string;
  targetLink: string | null;
  config: Record<string, unknown>;
  intervalSeconds: number;
  failureThreshold: number;
  recoveryThreshold: number;
  enabled: boolean;
  pausedReason: string | null;
  applicationId: string | null;
  /** Never the URL: it is the secret. Only its presence is public. */
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
  /** `true` as long as no measurement went through: the screen says so rather than 0%. */
  neverRan: boolean;
  uptime24h: UptimeView;
  uptime7d: UptimeView;
  /** Recent measurements, from the oldest to the most recent. */
  recent: Array<{ at: string; latencyMs: number | null; outcome: string }>;
  openIncidentSince: string | null;
  createdAt: string;
};

function view(window: UptimeWindow, language: UiLanguage): UptimeView {
  return { ...window, label: formatUptime(window, language) };
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
 * A list of probes, complete for the screen.
 *
 * The two availability windows are computed in **two grouped queries**, not in
 * two queries per probe: twenty probes are two queries, not forty.
 */
export async function buildMonitorViews(rows: Monitor[]): Promise<MonitorView[]> {
  const ids = rows.map((row) => row.id);
  const language = await currentLanguage();
  const [day, week] = await Promise.all([uptimeWindows(ids, 24), uptimeWindows(ids, 24 * 7)]);

  return Promise.all(
    rows.map(async (row) => {
      const [checks, incidents] = await Promise.all([
        listChecks(row.id, MONITOR_SPARKLINE_POINTS),
        listIncidents(row.id, 1),
      ]);
      const open = incidents.find((incident) => incident.resolvedAt === null) ?? null;
      const known = isMonitorType(row.type);
      const type: MonitorType = known ? (row.type as MonitorType) : 'http';
      const definition = monitorTypeDefinition(type, language);

      return {
        id: row.id,
        name: row.name,
        type,
        typeLabel: known
          ? definition.label
          : renderMessage(messages, language, 'type.unknown', { type: row.type }),
        // The same content as `@pupitre/db`'s `monitorTarget()`, but rendered in the
        // instance's language: the target is displayed, it is not logged.
        target: known
          ? describeMonitorTarget(type, row.config, language)
          : renderMessage(messages, language, 'target.unknownType'),
        targetLink: known ? monitorTargetLink(type, row.config) : null,
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
        uptime24h: view(day.get(row.id) ?? { hours: 24, samples: 0, up: 0, ratio: null }, language),
        uptime7d: view(
          week.get(row.id) ?? { hours: 168, samples: 0, up: 0, ratio: null },
          language,
        ),
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
 * The catalog, serialized for the screen.
 *
 * The Zod schemas do not cross the server/client boundary: we only send what the
 * form must know — fields, measurements, bounds, starting values. That is what
 * allows the screen to build itself without any `if (type === 'http')`.
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

export async function monitorTypeOptions(
  types: readonly MonitorType[],
): Promise<MonitorTypeOption[]> {
  const language = await currentLanguage();
  return types.map((type) => {
    const definition = monitorTypeDefinition(type, language);
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
