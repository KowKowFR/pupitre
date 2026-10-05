import { z } from 'zod';
import { defineMessages, renderMessage, type UiLanguage } from './i18n.js';

/**
 * Forecasts: what is going to break, before it breaks.
 *
 * **Without AI, and on purpose.** Each forecast is a computation that can be
 * redone by hand — a slope, a median, a count — from what the database already
 * keeps: 30 days of machine readings, 30 days of probe measurements, the
 * certificates, the backups, the deployments. A forecast therefore always says
 * **why**: "the disk gains 2.1 points per day".
 *
 * **Cautious rather than chatty.** A slope only counts if it is clear
 * (coefficient of determination), held over enough time, and if it leads to the
 * wall within a horizon where one can still act. A false forecast alert wears
 * down trust faster than a real outage.
 *
 * This module is pure: the worker passes it series, it returns findings.
 */

export const FORECAST_KINDS = [
  'disk_full',
  'memory_growth',
  'load_rising',
  'latency_degrading',
  'monitor_flapping',
  'certificate_renewal_late',
  'backup_stale',
  'deploys_failing',
] as const;
export type ForecastKind = (typeof FORECAST_KINDS)[number];

export const FORECAST_SUBJECTS = ['target', 'monitor', 'route', 'application'] as const;
export type ForecastSubjectType = (typeof FORECAST_SUBJECTS)[number];

/** `soon`: to handle within three days. `watch`: to keep an eye on. */
export const FORECAST_SEVERITIES = ['soon', 'watch'] as const;
export type ForecastSeverity = (typeof FORECAST_SEVERITIES)[number];

export const forecastSchema = z.object({
  kind: z.enum(FORECAST_KINDS),
  subject: z.object({
    type: z.enum(FORECAST_SUBJECTS),
    id: z.string().min(1),
    name: z.string(),
  }),
  severity: z.enum(FORECAST_SEVERITIES),
  /** When the wall is reached, if the forecast has one. */
  etaAt: z.string().nullable(),
  /** The figures that justify the finding, for the sentence and for the audit log. */
  detail: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
});
export type Forecast = z.infer<typeof forecastSchema>;

const DAY_MS = 86_400_000;

/** A point of a series: an instant (ms) and a value. */
export type SeriesPoint = { t: number; v: number };

/**
 * The least-squares line of a series: its slope **per day**, and its
 * coefficient of determination (1: the series is a line; 0: no trend).
 */
export function fitLine(points: readonly SeriesPoint[]): {
  slopePerDay: number;
  intercept: number;
  r2: number;
  n: number;
} {
  const n = points.length;
  if (n < 2) return { slopePerDay: 0, intercept: points[0]?.v ?? 0, r2: 0, n };
  const xs = points.map((point) => point.t / DAY_MS);
  const ys = points.map((point) => point.v);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i]! - meanX) * (ys[i]! - meanY);
    sxx += (xs[i]! - meanX) ** 2;
    syy += (ys[i]! - meanY) ** 2;
  }
  if (sxx === 0) return { slopePerDay: 0, intercept: meanY, r2: 0, n };
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slopePerDay: slope, intercept: meanY - slope * meanX, r2, n };
}

export type FillForecast = {
  /** The last value, smoothed by the line. */
  current: number;
  slopePerDay: number;
  r2: number;
  /** Days before reaching the limit. */
  etaDays: number;
};

/**
 * When will a rising series reach `limit`? `null` if it does not rise enough,
 * clearly enough, for long enough, or if the wall is beyond the horizon.
 */
export function forecastFill(
  points: readonly SeriesPoint[],
  limit: number,
  options: { minSlopePerDay: number; minR2: number; minSpanDays: number; horizonDays: number },
): FillForecast | null {
  if (points.length < 6) return null;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const span = (sorted[sorted.length - 1]!.t - sorted[0]!.t) / DAY_MS;
  if (span < options.minSpanDays) return null;
  const fit = fitLine(sorted);
  if (fit.slopePerDay < options.minSlopePerDay || fit.r2 < options.minR2) return null;
  const lastT = sorted[sorted.length - 1]!.t / DAY_MS;
  const current = fit.intercept + fit.slopePerDay * lastT;
  // Already at the wall: it is a threshold breach, no longer a forecast.
  if (current >= limit) return null;
  const etaDays = (limit - current) / fit.slopePerDay;
  if (etaDays > options.horizonDays) return null;
  return { current, slopePerDay: fit.slopePerDay, r2: fit.r2, etaDays };
}

function severityOf(etaDays: number): ForecastSeverity {
  return etaDays <= 3 ? 'soon' : 'watch';
}

const iso = (ms: number) => new Date(ms).toISOString();
const round1 = (value: number) => Math.round(value * 10) / 10;

type Subject = Forecast['subject'];

/** A machine's disk, toward 95% — a slope held for at least two days, within 14 days. */
export function forecastDisk(
  subject: Subject,
  points: readonly SeriesPoint[],
  now: number,
  sizeGib: number | null,
): Forecast | null {
  const fill = forecastFill(points, 95, {
    minSlopePerDay: 0.3,
    minR2: 0.6,
    minSpanDays: 2,
    horizonDays: 14,
  });
  if (!fill) return null;
  return {
    kind: 'disk_full',
    subject,
    severity: severityOf(fill.etaDays),
    etaAt: iso(now + fill.etaDays * DAY_MS),
    detail: {
      current: round1(fill.current),
      ratePerDay: round1(fill.slopePerDay),
      etaDays: round1(fill.etaDays),
      gibPerDay: sizeGib === null ? null : round1((fill.slopePerDay / 100) * sizeGib),
    },
  };
}

/**
 * Memory that rises without coming down: a probable leak. A clear slope
 * (r² ≥ 0.8) over at least a day, toward 95% within the week.
 */
export function forecastMemory(
  subject: Subject,
  points: readonly SeriesPoint[],
  now: number,
): Forecast | null {
  const fill = forecastFill(points, 95, {
    minSlopePerDay: 2,
    minR2: 0.8,
    minSpanDays: 1,
    horizonDays: 7,
  });
  if (!fill) return null;
  return {
    kind: 'memory_growth',
    subject,
    severity: severityOf(fill.etaDays),
    etaAt: iso(now + fill.etaDays * DAY_MS),
    detail: {
      current: round1(fill.current),
      ratePerDay: round1(fill.slopePerDay),
      etaDays: round1(fill.etaDays),
    },
  };
}

/** Load rising day after day toward the machine's threshold, within the week. */
export function forecastLoad(
  subject: Subject,
  points: readonly SeriesPoint[],
  limit: number,
  now: number,
): Forecast | null {
  const fill = forecastFill(points, limit, {
    minSlopePerDay: 3,
    minR2: 0.6,
    minSpanDays: 3,
    horizonDays: 7,
  });
  if (!fill) return null;
  return {
    kind: 'load_rising',
    subject,
    severity: severityOf(fill.etaDays),
    etaAt: iso(now + fill.etaDays * DAY_MS),
    detail: {
      current: round1(fill.current),
      ratePerDay: round1(fill.slopePerDay),
      etaDays: round1(fill.etaDays),
      limit,
    },
  };
}

/**
 * A probe slowing down: the median of the last 24 h against that of the six
 * days before. It takes enough measurements on both sides, a rise of at least
 * half, and of at least 100 ms — 40 ms turning into 70 ms says nothing.
 */
export function forecastLatency(
  subject: Subject,
  window: {
    recentMedian: number | null;
    recentCount: number;
    baselineMedian: number | null;
    baselineCount: number;
  },
): Forecast | null {
  const { recentMedian, baselineMedian } = window;
  if (recentMedian === null || baselineMedian === null) return null;
  if (window.recentCount < 20 || window.baselineCount < 50 || baselineMedian <= 0) return null;
  const ratio = recentMedian / baselineMedian;
  if (ratio < 1.5 || recentMedian - baselineMedian < 100) return null;
  return {
    kind: 'latency_degrading',
    subject,
    severity: ratio >= 3 ? 'soon' : 'watch',
    etaAt: null,
    detail: {
      recentMs: Math.round(recentMedian),
      baselineMs: Math.round(baselineMedian),
      ratio: round1(ratio),
    },
  };
}

/**
 * A probe that keeps flipping between up and down: the sign of a fragile
 * service, before the outright outage. Six flips or more in 24 h.
 */
export function forecastFlapping(subject: Subject, flips: number): Forecast | null {
  if (flips < 6) return null;
  return {
    kind: 'monitor_flapping',
    subject,
    severity: flips >= 12 ? 'soon' : 'watch',
    etaAt: null,
    detail: { flips },
  };
}

/** How many times a sequence of verdicts switches sides (healthy ↔ not healthy). */
export function countFlips(outcomes: readonly string[]): number {
  let flips = 0;
  for (let i = 1; i < outcomes.length; i += 1) {
    if ((outcomes[i] === 'healthy') !== (outcomes[i - 1] === 'healthy')) flips += 1;
  }
  return flips;
}

/**
 * A certificate that should have been renewed: Let's Encrypt (and Traefik) do
 * it 30 days before expiry. With less than 20 days left, the renewal is late —
 * there is still time to understand why.
 */
export function forecastCertificate(
  subject: Subject,
  notAfter: string | null,
  now: number,
): Forecast | null {
  if (!notAfter) return null;
  const left = (Date.parse(notAfter) - now) / DAY_MS;
  if (Number.isNaN(left) || left < 0 || left >= 20) return null;
  return {
    kind: 'certificate_renewal_late',
    subject,
    severity: severityOf(left),
    etaAt: new Date(Date.parse(notAfter)).toISOString(),
    detail: { daysLeft: Math.floor(left) },
  };
}

/**
 * A backed-up application that has not been backed up for two days (or never,
 * two days after enabling): the backup we will need may not exist.
 */
export function forecastBackup(
  subject: Subject,
  lastSuccessAt: string | null,
  enabledSince: string,
  now: number,
): Forecast | null {
  const reference = Date.parse(lastSuccessAt ?? enabledSince);
  if (Number.isNaN(reference)) return null;
  const hours = (now - reference) / 3_600_000;
  if (hours < 48) return null;
  return {
    kind: 'backup_stale',
    subject,
    severity: hours >= 96 ? 'soon' : 'watch',
    etaAt: null,
    detail: { hours: Math.floor(hours), never: lastSuccessAt === null ? 1 : 0 },
  };
}

/**
 * A machine where deployments fail one after the other: the week's last three,
 * failed or rolled back. The next one will probably fail too.
 */
export function forecastDeploys(
  subject: Subject,
  recent: ReadonlyArray<{ status: string; createdAt: string }>,
  now: number,
): Forecast | null {
  const week = recent.filter((entry) => now - Date.parse(entry.createdAt) <= 7 * DAY_MS);
  const lastThree = week.slice(0, 3);
  if (lastThree.length < 3) return null;
  if (!lastThree.every((entry) => entry.status === 'failed' || entry.status === 'rolled_back'))
    return null;
  return {
    kind: 'deploys_failing',
    subject,
    severity: 'watch',
    etaAt: null,
    detail: { failures: lastThree.length },
  };
}

// ─── A forecast's words ───────────────────────────────────────────────────────

/**
 * A forecast's sentences, in both languages. They live next to the computation
 * because two readers use them: the screen ("Upcoming") and the notification,
 * composed by the worker with nobody in front of the screen.
 */
export const forecastMessages = defineMessages({
  fr: {
    'disk_full.title': 'Disque bientôt plein',
    'disk_full.sentence':
      'Le disque de « {name} » sera plein (95 %) dans ~{eta} : il gagne {rate} points par jour{volume}, à {current} % aujourd’hui.',
    'disk_full.volume': ' ({gib} Gio)',
    'memory_growth.title': 'Mémoire qui ne redescend pas',
    'memory_growth.sentence':
      'La mémoire de « {name} » monte de {rate} points par jour sans redescendre : 95 % dans ~{eta}. Une fuite probable — un service à redémarrer, puis à corriger.',
    'load_rising.title': 'Charge en hausse',
    'load_rising.sentence':
      'La charge de « {name} » monte de {rate} points par jour : son seuil de {limit} % dans ~{eta}.',
    'latency_degrading.title': 'Sonde plus lente',
    'latency_degrading.sentence':
      '« {name} » répond en {recent} ms depuis 24 h, contre {baseline} ms d’habitude (×{ratio}).',
    'monitor_flapping.title': 'Sonde instable',
    'monitor_flapping.sentence':
      '« {name} » a basculé {flips} fois en 24 h entre en ligne et en panne : un service fragile, avant la panne franche.',
    'certificate_renewal_late.title': 'Certificat non renouvelé',
    'certificate_renewal_late.sentence':
      'Le certificat de « {name} » expire dans {days} jours et n’a pas été renouvelé — il aurait dû l’être à 30 jours.',
    'backup_stale.title': 'Sauvegarde en retard',
    'backup_stale.sentence': '« {name} » n’a pas été sauvegardée depuis {hours} h.',
    'backup_stale.never':
      '« {name} » n’a encore jamais été sauvegardée, {hours} h après l’activation de sa sauvegarde.',
    'deploys_failing.title': 'Déploiements en échec',
    'deploys_failing.sentence':
      'Les {failures} derniers déploiements sur « {name} » ont échoué : le suivant échouera sans doute aussi.',
    'eta.hours': { one: '{count} heure', other: '{count} heures' },
    'eta.days': { one: '{count} jour', other: '{count} jours' },
    'severity.soon': 'bientôt',
    'severity.watch': 'à surveiller',
  },
  en: {
    'disk_full.title': 'Disk filling up',
    'disk_full.sentence':
      'The disk of “{name}” will be full (95%) in ~{eta}: it gains {rate} points a day{volume}, at {current}% today.',
    'disk_full.volume': ' ({gib} GiB)',
    'memory_growth.title': 'Memory that never comes back down',
    'memory_growth.sentence':
      'Memory on “{name}” rises {rate} points a day without coming back down: 95% in ~{eta}. Likely a leak — a service to restart, then to fix.',
    'load_rising.title': 'Rising load',
    'load_rising.sentence':
      'Load on “{name}” rises {rate} points a day: its {limit}% threshold in ~{eta}.',
    'latency_degrading.title': 'Slower monitor',
    'latency_degrading.sentence':
      '“{name}” has answered in {recent} ms for 24 h, against {baseline} ms usually (×{ratio}).',
    'monitor_flapping.title': 'Unstable monitor',
    'monitor_flapping.sentence':
      '“{name}” flipped {flips} times in 24 h between up and down: a fragile service, before the outright outage.',
    'certificate_renewal_late.title': 'Certificate not renewed',
    'certificate_renewal_late.sentence':
      'The certificate of “{name}” expires in {days} days and was not renewed — it should have been at 30 days.',
    'backup_stale.title': 'Backup overdue',
    'backup_stale.sentence': '“{name}” has not been backed up for {hours} h.',
    'backup_stale.never':
      '“{name}” has never been backed up, {hours} h after its backup was turned on.',
    'deploys_failing.title': 'Deployments failing',
    'deploys_failing.sentence':
      'The last {failures} deployments on “{name}” failed: the next one will likely fail too.',
    'eta.hours': { one: '{count} hour', other: '{count} hours' },
    'eta.days': { one: '{count} day', other: '{count} days' },
    'severity.soon': 'soon',
    'severity.watch': 'to watch',
  },
});

type ForecastMessageKey = keyof (typeof forecastMessages)['fr'] & string;

/** A forecast's sentence, in the requested language — numbers included. */
export function describeForecast(
  forecast: Pick<Forecast, 'kind' | 'subject' | 'detail'>,
  language: UiLanguage,
): { title: string; sentence: string } {
  const t = (key: ForecastMessageKey, vars?: Record<string, string | number>) =>
    renderMessage(forecastMessages, language, key, vars);
  const number = (value: unknown, digits = 1) =>
    typeof value === 'number'
      ? new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(value)
      : '?';
  const d = forecast.detail;
  const eta = (() => {
    const days = typeof d.etaDays === 'number' ? d.etaDays : null;
    if (days === null) return '?';
    // Under two days, "~1 day" would round 34 hours to 24: hours say it better.
    if (days < 2) return t('eta.hours', { count: Math.max(1, Math.round(days * 24)) });
    return t('eta.days', { count: Math.round(days) });
  })();
  const name = forecast.subject.name;
  const kind = forecast.kind;
  const title = t(`${kind}.title`);
  switch (kind) {
    case 'disk_full':
      return {
        title,
        sentence: t('disk_full.sentence', {
          name,
          eta,
          rate: number(d.ratePerDay),
          current: number(d.current, 0),
          volume:
            typeof d.gibPerDay === 'number'
              ? t('disk_full.volume', { gib: number(d.gibPerDay) })
              : '',
        }),
      };
    case 'memory_growth':
      return {
        title,
        sentence: t('memory_growth.sentence', { name, eta, rate: number(d.ratePerDay) }),
      };
    case 'load_rising':
      return {
        title,
        sentence: t('load_rising.sentence', {
          name,
          eta,
          rate: number(d.ratePerDay),
          limit: number(d.limit, 0),
        }),
      };
    case 'latency_degrading':
      return {
        title,
        sentence: t('latency_degrading.sentence', {
          name,
          recent: number(d.recentMs, 0),
          baseline: number(d.baselineMs, 0),
          ratio: number(d.ratio),
        }),
      };
    case 'monitor_flapping':
      return {
        title,
        sentence: t('monitor_flapping.sentence', { name, flips: number(d.flips, 0) }),
      };
    case 'certificate_renewal_late':
      return {
        title,
        sentence: t('certificate_renewal_late.sentence', { name, days: number(d.daysLeft, 0) }),
      };
    case 'backup_stale':
      return {
        title,
        sentence: t(d.never === 1 ? 'backup_stale.never' : 'backup_stale.sentence', {
          name,
          hours: number(d.hours, 0),
        }),
      };
    case 'deploys_failing':
      return {
        title,
        sentence: t('deploys_failing.sentence', { name, failures: number(d.failures, 0) }),
      };
  }
}

/**
 * Where to read a forecast's subject: the drawer of its target, its probe, its
 * domain, its application. The same link in the screen and in the notification.
 */
export function forecastSubjectPath(subject: { type: ForecastSubjectType; id: string }): string {
  switch (subject.type) {
    case 'target':
      return `/targets?target=${subject.id}`;
    case 'monitor':
      return `/monitors?monitor=${subject.id}`;
    case 'route':
      return `/domains?domain=${subject.id}`;
    case 'application':
      return `/applications?app=${subject.id}`;
  }
}

/** The word for a forecast severity. */
export function forecastSeverityLabel(severity: ForecastSeverity, language: UiLanguage): string {
  return renderMessage(forecastMessages, language, `severity.${severity}`);
}
