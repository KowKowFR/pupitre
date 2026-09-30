'use client';

import * as React from 'react';
import { useT } from '@/i18n/client';
import { monitors as messages } from '@/i18n/messages/monitors';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Les deux figures de la supervision.
 *
 * Parti pris de lecture, et il vaut d'être écrit : les couleurs employées ici
 * sont les **couleurs d'état** du panel (`--ok`, `--warn`, `--danger`), jamais
 * une palette catégorielle. Elles signifient bien/mal, pas « série 1 / série 2 »,
 * et elles ne servent à rien d'autre dans l'écran.
 *
 * L'état n'est donc jamais porté par la seule couleur :
 *   — chaque barre de la frise porte une infobulle qui nomme son verdict ;
 *   — une légende nomme les trois couleurs sous la frise ;
 *   — le voyant `HealthDot` et le taux chiffré, à côté, redisent la même chose
 *     en toutes lettres ;
 *   — et le détail d'une sonde contient la table complète des mesures, qui est
 *     l'équivalent lisible sans couleur.
 *
 * Aucune valeur n'est enfermée derrière un survol.
 */

export type OutcomePoint = {
  at: string;
  latencyMs: number | null;
  outcome: string;
};

/** Les trois états, dans l'ordre où on les lit : du bon au pire. */
const OUTCOME_TONE: Record<string, string> = {
  healthy: 'var(--ok)',
  unhealthy: 'var(--warn)',
  unreachable: 'var(--danger)',
  unknown: 'var(--text-3)',
};

/**
 * L'heure d'un point, dans la locale de l'instance.
 *
 * Les composantes — jour, mois, heure, minute — sont imposées par la figure :
 * un axe n'a pas la place d'une date complète. La **locale**, elle, ne l'est
 * pas : elle vient de `settings.locale`, telle quelle (`fr-FR`, `en-GB`,
 * `en-US`), et descend par props comme partout ailleurs. Le raccourci d'avant
 * — `language === 'fr' ? 'fr-FR' : 'en-GB'` — donnait des dates britanniques à
 * une instance réglée sur `en-US`, et ignorait le réglage qu'elle avait posé.
 *
 * Le fuseau n'est **pas** imposé ici : le faire déplacerait l'heure affichée
 * sur toute instance dont le process ne tourne pas déjà dans le fuseau de
 * l'instance — et les conteneurs de ce projet tournent en UTC. C'est un
 * changement de rendu, pas une traduction ; il appartient à un autre commit.
 */
function formatClock(iso: string, format: FormatSettings): string {
  return formatDateTimeWith(iso, format, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── frise des verdicts ───────────────────────────────────────────────────────

/** La classe `.strip` de chaque verdict : vert par défaut, puis ambre, rouge, gris. */
const STRIP_CLASS: Record<string, string> = {
  healthy: '',
  unhealthy: 'w',
  unreachable: 'd',
  unknown: 'n',
};

/**
 * Une barre par mesure, de la plus ancienne à la plus récente.
 *
 * Deux pixels de fond entre les barres, jamais de bordure : c'est le fond qui
 * sépare, pas un trait. Une frise sans mesure ne s'affiche pas — elle dirait
 * « tout va bien » sur du vide.
 */
export function OutcomeStrip({
  points,
  format,
  className,
  height = 22,
}: {
  points: readonly OutcomePoint[];
  /** Locale et fuseau de l'instance. Par props : le serveur et le client
   *  doivent lire la même valeur, sinon l'hydratation diverge. */
  format: FormatSettings;
  className?: string;
  height?: number;
}) {
  const t = useT(messages);
  if (points.length === 0) return null;

  const outcomeLabel = (outcome: string): string =>
    outcome === 'healthy' ||
    outcome === 'unhealthy' ||
    outcome === 'unreachable' ||
    outcome === 'unknown'
      ? t(`outcome.${outcome}`)
      : outcome;

  return (
    <div
      className={cn('strip', className)}
      style={{ height }}
      role="img"
      aria-label={t('chart.strip.label', { count: points.length })}
    >
      {points.map((point) => (
        <i
          key={point.at}
          className={STRIP_CLASS[point.outcome] ?? 'n'}
          title={
            point.latencyMs === null
              ? t('chart.point.title', {
                  clock: formatClock(point.at, format),
                  outcome: outcomeLabel(point.outcome),
                })
              : t('chart.point.titleWithLatency', {
                  clock: formatClock(point.at, format),
                  outcome: outcomeLabel(point.outcome),
                  latency: point.latencyMs,
                })
          }
        />
      ))}
    </div>
  );
}

/** L'axe sous une frise : le premier passage à gauche, maintenant à droite. */
export function StripAxis({
  points,
  format,
  ticks = 2,
}: {
  points: readonly OutcomePoint[];
  format: FormatSettings;
  /** Nombre de repères, extrémités comprises. */
  ticks?: number;
}) {
  const t = useT(messages);
  if (points.length === 0) return null;
  const labels = Array.from({ length: ticks }, (_, index) => {
    if (index === ticks - 1) return t('axis.now');
    const point = points[Math.round((index / (ticks - 1)) * (points.length - 1))];
    return point ? clockOf(point.at, format) : '';
  });
  return (
    <div className="axis" aria-hidden>
      {labels.map((label, index) => (
        <span key={index}>{label}</span>
      ))}
    </div>
  );
}

function clockOf(iso: string, format: FormatSettings): string {
  return formatDateTimeWith(iso, format, { hour: '2-digit', minute: '2-digit' });
}

/** Légende de la frise. Nomme les couleurs : la teinte seule ne suffit jamais. */
export function OutcomeLegend({ className }: { className?: string }) {
  const t = useT(messages);
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
      {(['healthy', 'unhealthy', 'unreachable'] as const).map((outcome) => (
        <span
          key={outcome}
          className="inline-flex items-center gap-1.5 text-[0.6875rem] text-text-3"
        >
          <span
            aria-hidden
            className="inline-block h-2.5 w-1.5 rounded-[1px]"
            style={{ backgroundColor: OUTCOME_TONE[outcome] }}
          />
          {t(`outcome.${outcome}`)}
        </span>
      ))}
    </div>
  );
}

// ─── courbe de latence ────────────────────────────────────────────────────────

type Plotted = { x: number; y: number; point: OutcomePoint };

function buildGeometry(
  points: readonly OutcomePoint[],
  width: number,
  height: number,
  padTop: number,
  padBottom: number,
): { plotted: Plotted[]; gaps: number[]; max: number; step: number } {
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const values = points
    .map((point) => point.latencyMs)
    .filter((value): value is number => value !== null);
  // Un plancher à 1 ms évite une courbe écrasée sur une sonde très rapide.
  const max = Math.max(1, ...values);
  const usable = height - padTop - padBottom;

  const plotted: Plotted[] = [];
  const gaps: number[] = [];

  points.forEach((point, index) => {
    const x = points.length > 1 ? index * step : width / 2;
    if (point.latencyMs === null) {
      gaps.push(x);
      return;
    }
    plotted.push({ x, y: padTop + usable - (point.latencyMs / max) * usable, point });
  });

  return { plotted, gaps, max, step };
}

/** Découpe en segments continus : une mesure sans latence coupe le trait. */
function segmentsOf(points: readonly OutcomePoint[], plotted: Plotted[]): Plotted[][] {
  const byAt = new Map(plotted.map((entry) => [entry.point.at, entry]));
  const runs: Plotted[][] = [];
  let current: Plotted[] = [];
  for (const point of points) {
    const entry = byAt.get(point.at);
    if (entry) {
      current.push(entry);
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Courbe compacte des latences récentes — une seule série, donc pas de légende :
 * la colonne la nomme. Une aire pâle sous le trait, comme les autres courbes
 * du panel.
 *
 * Les mesures sans latence — rien n'a répondu — coupent le trait. Un trait qui
 * relierait les deux côtés d'une panne raconterait une continuité qui n'a pas
 * eu lieu.
 */
export function LatencySparkline({
  points,
  width = 150,
  height = 30,
  tone = 'var(--accent)',
  className,
}: {
  points: readonly OutcomePoint[];
  width?: number;
  height?: number;
  /** La teinte du trait : l'outremer, ou le danger quand la sonde est en panne. */
  tone?: string;
  className?: string;
}) {
  const t = useT(messages);
  const usable = points.filter((point) => point.latencyMs !== null);
  if (usable.length === 0) return null;

  const padTop = 3;
  const padBottom = 1;
  const { plotted } = buildGeometry(points, width, height, padTop, padBottom);
  const runs = segmentsOf(points, plotted);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('overflow-visible', className)}
      role="img"
      aria-label={t('chart.sparkline.label', { count: points.length })}
    >
      {runs.map((run) => {
        const line = run
          .map((entry, index) => `${index === 0 ? 'M' : 'L'}${entry.x} ${entry.y}`)
          .join(' ');
        const first = run[0];
        const last = run.at(-1);
        return (
          <g key={first?.point.at ?? 'run'}>
            {first && last ? (
              <path
                d={`${line} L${last.x} ${height} L${first.x} ${height} Z`}
                fill={tone}
                opacity={0.1}
              />
            ) : null}
            <path
              d={line}
              fill="none"
              stroke={tone}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        );
      })}
    </svg>
  );
}

// ─── courbe détaillée, avec réticule ──────────────────────────────────────────

/**
 * La même série, en grand, avec un réticule au survol.
 *
 * Pas d'axe des ordonnées : la valeur survolée s'affiche en clair, et la table
 * des mesures, plus bas dans l'écran, contient toutes les valeurs. Les mesures
 * sans réponse se regroupent en bandes hachurées rouges, bordées d'un pointillé.
 */
export function LatencyChart({
  points,
  format,
  height = 120,
  className,
}: {
  points: readonly OutcomePoint[];
  format: FormatSettings;
  height?: number;
  className?: string;
}) {
  const t = useT(messages);
  const [hover, setHover] = React.useState<number | null>(null);
  const width = 1000;
  const padTop = 8;
  const padBottom = 2;

  const usable = points.filter((point) => point.latencyMs !== null);
  if (points.length === 0 || usable.length === 0) return null;

  const { plotted, step } = buildGeometry(points, width, height, padTop, padBottom);
  const runs = segmentsOf(points, plotted);

  // Les trous consécutifs deviennent une seule bande, du trou au suivant.
  const bands: Array<{ from: number; to: number }> = [];
  points.forEach((point, index) => {
    if (point.latencyMs !== null) return;
    const x = points.length > 1 ? index * step : width / 2;
    const previous = bands.at(-1);
    if (previous && Math.abs(previous.to - (x - step)) < 0.5) previous.to = x;
    else bands.push({ from: x, to: x });
  });

  const active = hover === null ? null : (plotted[hover] ?? null);
  const ticks = [0, 1 / 3, 2 / 3, 1].map(
    (ratio) => points[Math.round(ratio * (points.length - 1))],
  );

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="block w-full"
          style={{ height }}
          role="img"
          aria-label={t('chart.latency.label')}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const x = ((event.clientX - rect.left) / rect.width) * width;
            if (plotted.length === 0) return;
            let nearest = 0;
            let best = Number.POSITIVE_INFINITY;
            plotted.forEach((entry, index) => {
              const distance = Math.abs(entry.x - x);
              if (distance < best) {
                best = distance;
                nearest = index;
              }
            });
            setHover(nearest);
          }}
        >
          <defs>
            <pattern
              id="latency-gap"
              width="9"
              height="9"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(0)"
            >
              <rect width="6" height="9" fill="var(--danger)" opacity="0.14" />
            </pattern>
          </defs>
          {bands.map((band) => (
            <g key={band.from}>
              <rect
                x={band.from - step / 2}
                y={0}
                width={Math.max(3, band.to - band.from + step)}
                height={height}
                fill="url(#latency-gap)"
              />
              <line
                x1={band.from - step / 2}
                x2={band.from - step / 2}
                y1={0}
                y2={height}
                stroke="var(--danger)"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
          {runs.map((run) => {
            const line = run
              .map((entry, index) => `${index === 0 ? 'M' : 'L'}${entry.x} ${entry.y}`)
              .join(' ');
            const first = run[0];
            const last = run.at(-1);
            return (
              <g key={first?.point.at ?? 'run'}>
                {first && last ? (
                  <path
                    d={`${line} L${last.x} ${height} L${first.x} ${height} Z`}
                    fill="var(--accent)"
                    opacity={0.1}
                  />
                ) : null}
                <path
                  d={line}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
          {active ? (
            <line
              x1={active.x}
              x2={active.x}
              y1={0}
              y2={height}
              stroke="var(--border-strong)"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {active ? (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-accent"
              style={{ left: `${(active.x / width) * 100}%`, top: active.y }}
            />
            <div className="pointer-events-none absolute top-0 right-0 rounded-md border border-border bg-surface px-2 py-1 text-[11px] shadow-sm">
              <div className="mono text-text">{active.point.latencyMs} ms</div>
              <div className="text-text-3">{formatClock(active.point.at, format)}</div>
            </div>
          </>
        ) : null}
      </div>
      <div className="axis" aria-hidden>
        {ticks.map((point, index) => (
          <span key={index}>{point ? clockOf(point.at, format) : ''}</span>
        ))}
      </div>
    </div>
  );
}
