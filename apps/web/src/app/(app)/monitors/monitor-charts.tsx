'use client';

import * as React from 'react';
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

const OUTCOME_LABEL: Record<string, string> = {
  healthy: 'sain',
  unhealthy: 'répond mal',
  unreachable: 'injoignable',
  unknown: 'inconnu',
};

/** Les trois états, dans l'ordre où on les lit : du bon au pire. */
const OUTCOME_TONE: Record<string, string> = {
  healthy: 'var(--ok)',
  unhealthy: 'var(--warn)',
  unreachable: 'var(--danger)',
  unknown: 'var(--ink-faint)',
};

function formatClock(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── frise des verdicts ───────────────────────────────────────────────────────

/**
 * Une barre par mesure, de la plus ancienne à la plus récente.
 *
 * Deux pixels de fond entre les barres, jamais de bordure : c'est le fond qui
 * sépare, pas un trait. Une frise sans mesure ne s'affiche pas — elle dirait
 * « tout va bien » sur du vide.
 */
export function OutcomeStrip({
  points,
  className,
  height = 22,
}: {
  points: readonly OutcomePoint[];
  className?: string;
  height?: number;
}) {
  if (points.length === 0) return null;

  return (
    <div
      className={cn('flex items-end gap-[2px]', className)}
      style={{ height }}
      role="img"
      aria-label={`${points.length} mesures, de la plus ancienne à la plus récente`}
    >
      {points.map((point) => (
        <span
          key={point.at}
          title={`${formatClock(point.at)} — ${OUTCOME_LABEL[point.outcome] ?? point.outcome}${
            point.latencyMs === null ? '' : ` · ${point.latencyMs} ms`
          }`}
          className="min-w-[3px] flex-1 rounded-[1px]"
          style={{
            height: '100%',
            backgroundColor: OUTCOME_TONE[point.outcome] ?? OUTCOME_TONE.unknown,
          }}
        />
      ))}
    </div>
  );
}

/** Légende de la frise. Nomme les couleurs : la teinte seule ne suffit jamais. */
export function OutcomeLegend({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
      {(['healthy', 'unhealthy', 'unreachable'] as const).map((outcome) => (
        <span key={outcome} className="inline-flex items-center gap-1.5 text-[0.6875rem] text-ink-faint">
          <span
            aria-hidden
            className="inline-block h-2.5 w-1.5 rounded-[1px]"
            style={{ backgroundColor: OUTCOME_TONE[outcome] }}
          />
          {OUTCOME_LABEL[outcome]}
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
 * le titre la nomme. La dernière valeur est étiquetée en clair à côté, de sorte
 * qu'aucun chiffre ne dépende du survol.
 *
 * Les mesures sans latence — rien n'a répondu — coupent le trait et laissent une
 * marque rouge sur la ligne de base. Un trait qui relierait les deux côtés d'une
 * panne raconterait une continuité qui n'a pas eu lieu.
 */
export function LatencySparkline({
  points,
  width = 120,
  height = 28,
  className,
}: {
  points: readonly OutcomePoint[];
  width?: number;
  height?: number;
  className?: string;
}) {
  const usable = points.filter((point) => point.latencyMs !== null);
  if (usable.length === 0) return null;

  const padTop = 3;
  const padBottom = 3;
  const { plotted, gaps } = buildGeometry(points, width, height, padTop, padBottom);
  const runs = segmentsOf(points, plotted);
  const last = plotted.at(-1);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('overflow-visible', className)}
      role="img"
      aria-label={`Latence des ${points.length} dernières mesures`}
    >
      {runs.map((run) => (
        <path
          key={run[0]?.point.at ?? 'run'}
          d={run.map((entry, index) => `${index === 0 ? 'M' : 'L'}${entry.x} ${entry.y}`).join(' ')}
          fill="none"
          stroke="var(--signal)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {gaps.map((x) => (
        <rect
          key={`gap-${x}`}
          x={x - 1}
          y={height - padBottom - 3}
          width={2}
          height={3}
          rx={1}
          fill="var(--danger)"
        />
      ))}
      {last ? (
        <circle
          cx={last.x}
          cy={last.y}
          r={2.5}
          fill="var(--signal)"
          stroke="var(--surface)"
          strokeWidth={2}
        />
      ) : null}
    </svg>
  );
}

// ─── courbe détaillée, avec réticule ──────────────────────────────────────────

/**
 * La même série, en grand, avec un réticule au survol.
 *
 * L'infobulle **enrichit**, elle ne conditionne rien : l'axe porte l'échelle, et
 * la table des mesures, plus bas dans l'écran, contient toutes les valeurs.
 */
export function LatencyChart({
  points,
  height = 160,
  className,
}: {
  points: readonly OutcomePoint[];
  height?: number;
  className?: string;
}) {
  const [hover, setHover] = React.useState<number | null>(null);
  const width = 720;
  const padTop = 12;
  const padBottom = 20;
  const padLeft = 44;

  const usable = points.filter((point) => point.latencyMs !== null);
  if (points.length === 0 || usable.length === 0) return null;

  const plotWidth = width - padLeft - 8;
  const { plotted, gaps, max } = buildGeometry(points, plotWidth, height, padTop, padBottom);
  const runs = segmentsOf(points, plotted);

  const ticks = [0, 0.5, 1].map((ratio) => ({
    value: Math.round(max * ratio),
    y: padTop + (height - padTop - padBottom) * (1 - ratio),
  }));

  const active = hover === null ? null : plotted[hover] ?? null;

  return (
    <div className={cn('relative', className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label="Latence mesurée au cours du temps"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - rect.left) / rect.width;
          const x = ratio * width - padLeft;
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
        {/* Grille : des filets pleins, un cran sous la surface. Jamais de pointillés. */}
        {ticks.map((tick) => (
          <g key={tick.value}>
            <line
              x1={padLeft}
              x2={width - 8}
              y1={tick.y}
              y2={tick.y}
              stroke="var(--line)"
              strokeWidth={1}
            />
            <text
              x={padLeft - 8}
              y={tick.y + 4}
              textAnchor="end"
              className="fill-ink-faint text-[10px] [font-variant-numeric:tabular-nums]"
            >
              {tick.value}
            </text>
          </g>
        ))}

        <g transform={`translate(${padLeft} 0)`}>
          {runs.map((run) => (
            <path
              key={run[0]?.point.at ?? 'run'}
              d={run
                .map((entry, index) => `${index === 0 ? 'M' : 'L'}${entry.x} ${entry.y}`)
                .join(' ')}
              fill="none"
              stroke="var(--signal)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {gaps.map((x) => (
            <rect
              key={`gap-${x}`}
              x={x - 1.5}
              y={padTop}
              width={3}
              height={height - padTop - padBottom}
              rx={1}
              fill="var(--danger)"
              opacity={0.18}
            />
          ))}
          {active ? (
            <>
              <line
                x1={active.x}
                x2={active.x}
                y1={padTop}
                y2={height - padBottom}
                stroke="var(--line-strong)"
                strokeWidth={1}
              />
              <circle
                cx={active.x}
                cy={active.y}
                r={4}
                fill="var(--signal)"
                stroke="var(--surface)"
                strokeWidth={2}
              />
            </>
          ) : null}
        </g>

        <text
          x={padLeft}
          y={height - 6}
          className="fill-ink-faint text-[10px] [font-variant-numeric:tabular-nums]"
        >
          {points[0] ? formatClock(points[0].at) : ''}
        </text>
        <text
          x={width - 8}
          y={height - 6}
          textAnchor="end"
          className="fill-ink-faint text-[10px] [font-variant-numeric:tabular-nums]"
        >
          {points.at(-1) ? formatClock(points.at(-1)!.at) : ''}
        </text>
      </svg>

      {active ? (
        <div className="pointer-events-none absolute top-0 right-0 rounded-md border border-line bg-surface px-2 py-1 text-[0.6875rem] shadow-raised">
          <div className="font-mono text-ink">{active.point.latencyMs} ms</div>
          <div className="text-ink-faint">{formatClock(active.point.at)}</div>
        </div>
      ) : null}
    </div>
  );
}
