'use client';

import { useCallback, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Translate } from '@pupitre/core';
import { Led, type Tone } from '@/components/instrument';
import { Alert } from '@/components/ui/alert';
import { SegmentedControl } from '@/components/ui/segmented';
import { useT } from '@/i18n/client';
import { servers } from '@/i18n/messages/servers';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Le passé d'un serveur, sous ses relevés.
 *
 * ── Pourquoi un chiffre seul ne dit rien ────────────────────────────────────
 * « Disque : 89 % » ne se lit pas. 89 % après six mois à 88 %, c'est un serveur
 * bien dimensionné ; 89 % après une semaine à 11 %, c'est une fuite qui remplira
 * la partition avant vendredi. Le même chiffre, deux situations opposées. Trois
 * choses lèvent l'ambiguïté, et elles sont toutes les trois affichées :
 *
 *   1. **la forme** — la frise, qui montre d'où ça vient ;
 *   2. **le pire relevé de la fenêtre** — la question qu'on se pose vraiment
 *      quand on arrive le lundi matin : « est-ce que ça a tapé le plafond
 *      pendant le week-end ? ». La dernière valeur ne peut pas y répondre ;
 *   3. **la tendance** — le sens et l'ampleur, en points de pourcentage.
 *
 * ── Pourquoi le seuil est *dessiné*, pas seulement écrit ────────────────────
 * Un trait en pointillé en travers de la frise transforme « 89 % contre un
 * seuil à 90 » en une image : les barres qui dépassent le trait sont le
 * problème, on les compte d'un coup d'œil. Les barres sont neutres, seul un
 * dépassement prend la couleur du danger — et il reste lisible en niveaux de
 * gris, par la position de la barre sur le trait et par le chiffre écrit à côté.
 *
 * ── Pourquoi l'historique s'affiche même machine éteinte ────────────────────
 * Il vient de la base, pas de la machine. C'est écrit dans la route
 * `metrics/history` : au moment précis où le relevé instantané n'a rien à dire,
 * la courbe des dernières 24 h est ce qu'on est venu chercher.
 */

export type HistoryMetric = 'disk' | 'memory' | 'load';

export type HistoryPointView = {
  at: string;
  samples: number;
  reachable: number;
  diskPercent: number | null;
  memoryPercent: number | null;
  loadPercent: number | null;
};

export type MetricSummaryView = {
  last: number | null;
  worst: number | null;
  trend: number | null;
};

export type ThresholdView = {
  limitPercent: number;
  enabled: boolean;
  origin: 'default' | 'global' | 'target';
};

export type BreachView = {
  id: string;
  metric: string;
  startedAt: string;
  limitPercent: number;
  peakValue: number;
  lastValue: number;
  samples: number;
};

export type HostHistoryData = {
  hours: number;
  samples: number;
  reachable: number;
  points: HistoryPointView[];
  summary: Record<HistoryMetric, MetricSummaryView>;
  thresholds: Record<HistoryMetric, ThresholdView>;
  breaches: BreachView[];
};

type T = Translate<typeof servers.fr>;

const METRIC_KEY: Record<HistoryMetric, keyof typeof servers.fr> = {
  disk: 'metric.disk',
  memory: 'metric.memory',
  load: 'metric.load',
};

/** Le nom d'une métrique inconnue du catalogue reste brut : c'est un identifiant. */
function metricLabel(metric: string, t: T): string {
  const key = METRIC_KEY[metric as HistoryMetric] as keyof typeof servers.fr | undefined;
  return key === undefined ? metric : t(key);
}

const METRIC_FIELD: Record<HistoryMetric, keyof HistoryPointView> = {
  disk: 'diskPercent',
  memory: 'memoryPercent',
  load: 'loadPercent',
};

const METRICS: readonly HistoryMetric[] = ['disk', 'memory', 'load'];

/**
 * La teinte d'une valeur, **rapportée à son seuil**.
 *
 * Le seuil réglable est devenu le seul nombre de référence : la couleur rouge
 * de l'écran et la ligne d'audit qui réveille quelqu'un parlent maintenant du
 * même chiffre. Avant, l'écran rougissait à 90 % en dur pendant qu'une alerte
 * aurait pu être réglée ailleurs — deux vocabulaires pour une seule question.
 */
export function toneFor(value: number | null, limit: number, enabled: boolean): Tone {
  if (value === null) return 'idle';
  if (!enabled) return 'idle';
  if (value > limit) return 'danger';
  // 85 % du seuil : assez tôt pour agir, assez tard pour ne pas crier au loup.
  if (value > limit * 0.85) return 'warn';
  return 'ok';
}

function formatPercent(value: number | null, t: T): string {
  if (value === null) return '—';
  return t('percent', { value: value.toFixed(value < 10 ? 1 : 0) });
}

/** La charge se lit mieux « par cœur » qu'en pourcentage de capacité. */
function formatValue(metric: HistoryMetric, value: number | null, t: T): string {
  if (value === null) return '—';
  if (metric === 'load') return `${(value / 100).toFixed(2)}`;
  return formatPercent(value, t);
}

/**
 * L'instant d'un intervalle, dans l'infobulle d'une barre.
 *
 * Les composantes sont imposées par la place — `13/09 00:33` tient dans un
 * `title`, une date longue non. La locale, elle, vient des paramètres
 * d'instance et descend par props : ce composant est client, et
 * `13/09 00:33` sur un panel anglais se lit à l'envers un jour sur deux.
 */
function formatClock(iso: string, format: FormatSettings): string {
  return formatDateTimeWith(iso, format, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sinceLabel(iso: string, t: T): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 3600) {
    return t('breach.since.minutes', { count: Math.max(1, Math.floor(seconds / 60)) });
  }
  if (seconds < 86_400) return t('breach.since.hours', { count: Math.floor(seconds / 3600) });
  return t('breach.since.days', { count: Math.floor(seconds / 86_400) });
}

/**
 * La tendance sur la fenêtre, en points de pourcentage : « stable », « +6 pt ».
 *
 * Sous un point, il n'y a pas de tendance : il y a du bruit. Annoncer
 * « +0,3 pt » ferait croire à un mouvement.
 */
export function trendText(trend: number | null, t: T): string {
  if (trend === null || Math.abs(trend) < 1) return t('trend.stable');
  return `${trend > 0 ? '+' : '−'}${t('trend.points', { value: Math.abs(trend).toFixed(0) })}`;
}

/** Hachures d'un intervalle sans mesure — le même motif que les autres frises. */
const HATCH = 'repeating-linear-gradient(45deg, var(--surface-3) 0 3px, transparent 3px 6px)';

/**
 * La frise d'une métrique : une barre par intervalle, le **pire relevé** de
 * l'intervalle, et le seuil en travers.
 *
 * Le pire et non la moyenne : on regarde une saturation. Une moyenne sur trente
 * minutes noie exactement le pic qu'on cherche.
 */
function Spark({
  metric,
  points,
  limit,
  enabled,
  format,
  height = 24,
}: {
  metric: HistoryMetric;
  points: readonly HistoryPointView[];
  limit: number;
  enabled: boolean;
  format: FormatSettings;
  height?: number;
}) {
  const t = useT(servers);
  const field = METRIC_FIELD[metric];
  const values = points.map((point) => point[field] as number | null);
  const measured = values.filter((value): value is number => value !== null);
  if (measured.length === 0) return <div className="flex-1" style={{ height }} />;

  // L'échelle monte au-delà de 100 quand la charge dépasse la capacité, et
  // laisse toujours le seuil visible dans le cadre.
  const ceiling = Math.max(100, limit * 1.1, ...measured);
  const limitY = height - (limit / ceiling) * height;

  return (
    <div
      className="relative min-w-0 flex-1"
      style={{ height }}
      role="img"
      aria-label={t('spark.aria', {
        metric: metricLabel(metric, t),
        count: points.length,
      })}
    >
      <div className="absolute inset-0 flex items-end gap-px">
        {points.map((point, index) => {
          const value = values[index] ?? null;
          if (value === null) {
            // Aucun relevé exploitable dans cet intervalle : des hachures, pas
            // une barre à zéro. Zéro voudrait dire « disque vide ».
            return (
              <i
                key={point.at}
                title={t('spark.empty', { clock: formatClock(point.at, format) })}
                className="h-full min-w-[2px] flex-1 rounded-[2px] opacity-70"
                style={{ background: HATCH }}
              />
            );
          }
          const over = enabled && value > limit;
          return (
            <i
              key={point.at}
              title={t('spark.point', {
                clock: formatClock(point.at, format),
                value: formatPercent(value, t),
                over: over ? t('spark.over', { limit }) : '',
              })}
              className={cn(
                'min-w-[2px] flex-1 rounded-t-[2px]',
                over ? 'bg-danger' : 'opacity-45',
              )}
              style={{
                height: Math.max(2, (value / ceiling) * height),
                background: over ? undefined : 'var(--gauge-fill)',
              }}
            />
          );
        })}
      </div>
      {enabled ? (
        <span
          aria-hidden
          className="pointer-events-none absolute right-0 left-0 border-t border-dashed border-text-3"
          style={{ top: Math.max(0, limitY) }}
          title={t('spark.limit', { limit })}
        />
      ) : null}
    </div>
  );
}

function MetricLine({
  metric,
  data,
  format,
}: {
  metric: HistoryMetric;
  data: HostHistoryData;
  format: FormatSettings;
}) {
  const t = useT(servers);
  const summary = data.summary[metric];
  const threshold = data.thresholds[metric];
  const tone = toneFor(summary.worst, threshold.limitPercent, threshold.enabled);
  // La charge se lit « par cœur » ; sa tendance aussi, pas en points.
  const trend =
    metric === 'load' && summary.trend !== null && Math.abs(summary.trend) >= 1
      ? `${summary.trend > 0 ? '+' : '−'}${(Math.abs(summary.trend) / 100).toFixed(2)}`
      : trendText(summary.trend, t);

  return (
    <div className="flex items-center gap-3">
      <span className="flex w-24 shrink-0 items-center gap-2 text-[12.5px] font-medium text-text-2">
        <Led tone={tone} />
        {metricLabel(metric, t)}
      </span>

      <Spark
        metric={metric}
        points={data.points}
        limit={threshold.limitPercent}
        enabled={threshold.enabled}
        format={format}
      />

      <span className="mono flex w-[15rem] shrink-0 items-center justify-end gap-3 text-[11.5px] tabular-nums max-sm:hidden">
        <span className="text-text-3">
          {t('metric.worst')}{' '}
          <span className={cn('font-medium', tone === 'danger' ? 'text-danger-text' : 'text-text')}>
            {formatValue(metric, summary.worst, t)}
          </span>
        </span>
        <span className="text-text-2">{trend}</span>
        <span
          className="text-text-3"
          title={
            threshold.origin === 'target'
              ? t('threshold.from.target')
              : threshold.origin === 'global'
                ? t('threshold.from.global')
                : t('threshold.from.default')
          }
        >
          {threshold.enabled
            ? t('threshold.value', {
                value: formatValue(metric, threshold.limitPercent, t),
              })
            : t('threshold.off')}
          {threshold.origin === 'default' ? '' : ' *'}
        </span>
      </span>
    </div>
  );
}

/**
 * Les dépassements en cours, sous la bande de relevés. Un encadré par
 * dépassement : la métrique, depuis quand, la valeur et le pire.
 */
export function OpenBreaches({ breaches }: { breaches: readonly BreachView[] }) {
  const t = useT(servers);
  if (breaches.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle px-4 py-2.5">
      {breaches.map((breach) => (
        <Alert key={breach.id} variant="warn">
          {t('breach.line', {
            metric: metricLabel(breach.metric, t),
            limit: breach.limitPercent,
            since: sinceLabel(breach.startedAt, t),
            last: formatPercent(breach.lastValue, t),
            peak: formatPercent(breach.peakValue, t),
            samples: t('breach.samples', { count: breach.samples }),
          })}
        </Alert>
      ))}
    </div>
  );
}

/**
 * L'historique se replie sous la bande de relevés : la bande répond à « comment
 * va-t-elle », la frise à « depuis quand ». Il s'ouvre de lui-même quand la
 * seconde question est celle qu'on se pose — machine injoignable, seuil franchi.
 *
 * Un `<details>` natif et non un dépliant à `aria-expanded` : il ne coûte aucun
 * état, et le contrat de l'écran réserve `aria-expanded` à la liste des
 * applications d'un serveur.
 */
export function HostHistory({
  targetId,
  initial,
  format,
  defaultOpen = false,
}: {
  targetId: string;
  initial: HostHistoryData;
  /** Le formatage descend par props : la frise est cliente, la locale non. */
  format: FormatSettings;
  defaultOpen?: boolean;
}) {
  const t = useT(servers);
  const [data, setData] = useState<HostHistoryData>(initial);
  const [loading, setLoading] = useState(false);

  /**
   * Le changement de fenêtre est la **seule** requête que cet écran déclenche
   * pour l'historique : les 24 h sont rendues avec la page, côté serveur. Un
   * `useEffect` qui irait chercher les 24 h au montage aurait fait deux allers
   * pour la même donnée, et affiché un vide entre les deux.
   */
  const select = useCallback(
    async (hours: number) => {
      if (hours === data.hours || loading) return;
      setLoading(true);
      try {
        const response = await fetch(
          `/api/targets/${targetId}/metrics/history?hours=${hours}&buckets=56`,
          { cache: 'no-store' },
        );
        if (response.ok) setData((await response.json()) as HostHistoryData);
      } finally {
        setLoading(false);
      }
    },
    [targetId, data.hours, loading],
  );

  if (data.samples === 0) {
    return (
      <p className="t-cap border-t border-border-subtle px-4 py-3 text-text-3">
        {t('history.empty')}
      </p>
    );
  }

  return (
    <details
      className="group relative border-t border-border-subtle"
      open={defaultOpen}
      aria-busy={loading || undefined}
    >
      <summary className="t-cap flex cursor-pointer list-none items-center gap-1.5 rounded-sm px-4 py-2.5 group-open:pr-28 text-text-3 outline-none hover:text-text-2 focus-visible:shadow-focus [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3.5 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="font-medium text-text-2">{t('history.toggle')}</span>
        <span className="min-w-0 truncate">
          {'· '}
          {t('history.samples', { count: data.samples })}
          {data.reachable === data.samples
            ? ''
            : t('history.unanswered', { count: data.samples - data.reachable })}
        </span>
      </summary>
      <SegmentedControl
        className="absolute top-1.5 right-4"
        label={t('history.window')}
        value={String(data.hours)}
        onChange={(value) => void select(Number(value))}
        options={WINDOWS.map((window) => ({ value: String(window.hours), label: t(window.key) }))}
      />
      <div className="flex flex-col gap-2 px-4 pt-1 pb-3">
        {METRICS.map((metric) => (
          <MetricLine key={metric} metric={metric} data={data} format={format} />
        ))}
      </div>
    </details>
  );
}

const WINDOWS = [
  { hours: 24, key: 'history.window.24h' },
  { hours: 168, key: 'history.window.7d' },
] as const satisfies readonly { hours: number; key: keyof typeof servers.fr }[];
