import type { ReactNode } from 'react';
import { Tooltip } from '@/components/ui/tooltip';
import { getT } from '@/i18n/server';
import { chrome } from '@/i18n/messages/chrome';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Le vocabulaire graphique du pupitre — la planche CompCharts.
 *
 * ── Pourquoi du SVG à la main plutôt qu'une bibliothèque ────────────────────
 * Recharts pèse 7,4 Mo décompressés et tire une pile de gestion d'état
 * complète ; Chart.js 6,2 Mo, ApexCharts 21,5 Mo. Surtout, toutes rendent dans
 * le navigateur : chaque figure deviendrait un composant client, et un tableau
 * de bord entièrement rendu sur le serveur se mettrait à hydrater. Les figures
 * ci-dessous sont des composants serveur ; le SVG arrive fini dans la page.
 *
 * ── Des pistes sur un axe partagé ───────────────────────────────────────────
 * Le kit pose les figures en pistes : le nom et ce qu'elles mesurent dans une
 * colonne à gauche, la figure à droite, et un seul axe du temps sous la pile.
 * Pas de graduation verticale : le chiffre qui compte est dans les relevés
 * au-dessus, et chaque marque porte un `title` qui la dit en toutes lettres.
 * Aucun texte n'est dans le SVG, qui s'étire (`preserveAspectRatio="none"`) :
 * un `<text>` y serait écrasé.
 *
 * ── La règle qui gouverne ces figures ───────────────────────────────────────
 * **Un seau sans mesure ne se dessine pas comme un zéro.** Il reçoit une trame
 * pâle, et il est compté à part. Un seau qui ne porte qu'une ou deux mesures
 * est hachuré : son taux vaut 0 % ou 100 % et rien entre les deux, ce n'est pas
 * une valeur, c'est un tirage.
 *
 * ── Accessibilité ───────────────────────────────────────────────────────────
 * Les couleurs sont les couleurs d'état, jamais une palette catégorielle ;
 * chaque figure est un `role="img"` avec un résumé ; une légende nomme les
 * teintes des barres ; aucune valeur n'est enfermée derrière un survol seul.
 */

const VIEW = 1000;

/** Sous ce nombre de mesures, un taux n'est qu'un tirage. */
const THIN_SAMPLES = 3;

export type Bucket = { at: string; samples: number };

export type Verdict = 'none' | 'sparse' | 'ok';

/**
 * Assez de données pour dessiner ? `none` : rien ; `sparse` : moins d'un quart
 * des seaux couverts — on dessine, mais on le dit ; `ok` : on dessine.
 */
export function densityOf(buckets: readonly Bucket[]): {
  verdict: Verdict;
  covered: number;
  thin: number;
  samples: number;
} {
  let covered = 0;
  let thin = 0;
  let samples = 0;
  for (const bucket of buckets) {
    samples += bucket.samples;
    if (bucket.samples === 0) continue;
    covered += 1;
    if (bucket.samples < THIN_SAMPLES) thin += 1;
  }
  const floor = Math.max(3, Math.round(buckets.length * 0.25));
  const verdict: Verdict = covered === 0 ? 'none' : covered < floor ? 'sparse' : 'ok';
  return { verdict, covered, thin, samples };
}

function clock(iso: string, format: FormatSettings): string {
  return formatDateTimeWith(iso, format, { hour: '2-digit', minute: '2-digit' });
}

function dayClock(iso: string, format: FormatSettings): string {
  return formatDateTimeWith(iso, format, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const HATCH = 'repeating-linear-gradient(45deg, var(--surface-3) 0 3px, transparent 3px 6px)';

// ─── barres de taux ───────────────────────────────────────────────────────────

export type RatioBucket = Bucket & {
  /** Mesures « bonnes » dans le seau (sondes saines, par exemple). */
  hits: number;
};

/**
 * Une barre par seau, haute de sa part de mesures saines. Vert quand tout est
 * sain, rouge quand rien ne l'est, ambre entre les deux ; hachurée sous
 * `THIN_SAMPLES` mesures, trame pâle sans mesure.
 */
export async function RatioBars({
  buckets,
  height = 44,
  label,
  unit,
  format,
}: {
  /** Conservé pour l'API : les barres sont en HTML, sans motif SVG à nommer. */
  id?: string;
  buckets: readonly RatioBucket[];
  height?: number;
  label: string;
  unit: string;
  format: FormatSettings;
}) {
  const t = await getT(chrome);
  const density = densityOf(buckets);

  return (
    <div
      className="flex items-end gap-[3px]"
      style={{ height }}
      role="img"
      aria-label={t('chart.bars.summary', {
        label,
        covered: density.covered,
        total: buckets.length,
        samples: density.samples,
      })}
    >
      {buckets.map((bucket) => {
        if (bucket.samples === 0) {
          return (
            <i
              key={bucket.at}
              className="h-full min-w-0 flex-1 rounded-[3px] opacity-70"
              style={{ background: HATCH }}
              title={t('chart.bars.empty', { clock: clock(bucket.at, format) })}
            />
          );
        }
        const ratio = bucket.hits / bucket.samples;
        const thin = bucket.samples < THIN_SAMPLES;
        const tone = ratio === 1 ? 'var(--ok)' : ratio === 0 ? 'var(--danger)' : 'var(--warn)';
        return (
          <i
            key={bucket.at}
            className="min-w-0 flex-1 rounded-[3px]"
            style={{
              height: `${Math.max(8, ratio * 100)}%`,
              background: thin
                ? `repeating-linear-gradient(45deg, ${tone} 0 2px, color-mix(in srgb, ${tone} 25%, transparent) 2px 5px)`
                : tone,
              opacity: ratio === 1 && !thin ? 0.75 : 1,
            }}
            title={
              t('chart.bars.ratio', {
                clock: clock(bucket.at, format),
                hits: bucket.hits,
                samples: bucket.samples,
                unit,
              }) + (thin ? t('chart.bars.thin') : '')
            }
          />
        );
      })}
    </div>
  );
}

// ─── courbe ───────────────────────────────────────────────────────────────────

export type SeriesBucket = Bucket & { value: number | null };

/**
 * Une valeur par seau, en courbe à aire douce, avec un point sur la dernière
 * mesure. Un seau sans mesure coupe la courbe — une moyenne n'enjambe pas un
 * trou — et reçoit une trame pâle. `threshold` trace un seuil en tirets ambre.
 */
export async function SeriesLine({
  buckets,
  height = 44,
  label,
  max,
  unit = '',
  tone = 'var(--accent)',
  threshold,
  format,
}: {
  buckets: readonly SeriesBucket[];
  height?: number;
  label: string;
  max: number;
  unit?: string;
  tone?: string;
  threshold?: number;
  format: FormatSettings;
}) {
  const t = await getT(chrome);
  const count = buckets.length;
  const band = count > 0 ? VIEW / count : VIEW;
  const ceiling = Math.max(1, max);
  const padTop = 3;
  const usable = height - padTop - 1;
  const at = (index: number) => index * band + band / 2;
  const toY = (value: number) => padTop + usable - (Math.min(value, ceiling) / ceiling) * usable;

  const runs: { index: number; value: number }[][] = [];
  let run: { index: number; value: number }[] = [];
  buckets.forEach((bucket, index) => {
    if (bucket.value === null || bucket.samples === 0) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    run.push({ index, value: bucket.value });
  });
  if (run.length > 0) runs.push(run);

  const lastRun = runs[runs.length - 1];
  const lastPoint = lastRun?.[lastRun.length - 1];
  const density = densityOf(buckets);

  return (
    <div className="relative" style={{ height }}>
      <svg
        viewBox={`0 0 ${VIEW} ${height}`}
        className="block w-full overflow-visible"
        style={{ height }}
        preserveAspectRatio="none"
        role="img"
        aria-label={t('chart.series.summary', { label, covered: density.covered, total: count })}
      >
        {buckets.map((bucket, index) =>
          bucket.samples === 0 ? (
            <rect
              key={`void-${bucket.at}`}
              x={index * band}
              y={0}
              width={band}
              height={height}
              fill="var(--surface-3)"
              opacity={0.6}
            >
              <title>{t('chart.series.void', { clock: clock(bucket.at, format) })}</title>
            </rect>
          ) : null,
        )}
        {threshold !== undefined && threshold <= ceiling ? (
          <line
            x1={0}
            x2={VIEW}
            y1={toY(threshold)}
            y2={toY(threshold)}
            stroke="var(--warn)"
            strokeWidth={1}
            strokeDasharray="2 2"
            opacity={0.8}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {runs.map((segment) => {
          const first = segment[0];
          const last = segment[segment.length - 1];
          if (!first || !last) return null;
          const line = segment
            .map((point, i) => `${i === 0 ? 'M' : 'L'}${at(point.index)} ${toY(point.value)}`)
            .join(' ');
          const area = `${line} L${at(last.index)} ${height} L${at(first.index)} ${height} Z`;
          return (
            <g key={`run-${first.index}`}>
              {segment.length > 1 ? <path d={area} fill={tone} opacity={0.1} /> : null}
              <path
                d={line}
                fill="none"
                stroke={tone}
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
        {buckets.map((bucket, index) =>
          bucket.value === null ? null : (
            <rect
              key={`hit-${bucket.at}`}
              x={index * band}
              y={0}
              width={band}
              height={height}
              fill="transparent"
            >
              <title>
                {t('chart.series.point', {
                  clock: clock(bucket.at, format),
                  value: Math.round(bucket.value),
                  unit,
                  count: bucket.samples,
                })}
              </title>
            </rect>
          ),
        )}
      </svg>
      {/* Le point final est en HTML : dans un SVG étiré, un cercle devient une ellipse. */}
      {lastPoint ? (
        <span
          aria-hidden
          className="pointer-events-none absolute size-[5px] rounded-full"
          style={{
            left: `calc(${(at(lastPoint.index) / VIEW) * 100}% - 2.5px)`,
            top: toY(lastPoint.value) - 2.5,
            background: tone,
          }}
        />
      ) : null}
    </div>
  );
}

// ─── rail d'événements ────────────────────────────────────────────────────────

export type TimelineEvent = {
  key: string;
  at: string;
  tone: 'ok' | 'warn' | 'danger' | 'accent' | 'idle' | 'hollow';
  title: string;
};

const EVENT_COLOR: Record<TimelineEvent['tone'], string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  accent: 'var(--accent)',
  idle: 'var(--idle)',
  hollow: 'var(--n400)',
};

/** Du plus anodin au plus grave — sert à colorer un amas par son pire élément. */
const TONE_RANK: Record<TimelineEvent['tone'], number> = {
  hollow: 0,
  idle: 0,
  ok: 1,
  accent: 2,
  warn: 3,
  danger: 4,
};

/**
 * Deux événements plus proches que ce ratio de la fenêtre fusionnent : sur
 * 24 h, 1,2 % fait un peu plus de 17 minutes.
 */
const CLUSTER_RATIO = 0.012;

/**
 * Les événements posés à leur instant exact sur une ligne. Chacun est une
 * pastille cerclée à la couleur de son issue, avec une info-bulle ; un amas
 * porte son effectif et prend la couleur de son pire membre.
 */
export async function EventRail({
  events,
  from,
  to,
  height = 28,
  label,
}: {
  events: readonly TimelineEvent[];
  from: string;
  to: string;
  height?: number;
  label: string;
}) {
  const t = await getT(chrome);
  const start = Date.parse(from);
  const end = Date.parse(to);
  const span = Math.max(1, end - start);

  const placed = events
    .map((event) => ({ event, ratio: (Date.parse(event.at) - start) / span }))
    .filter((entry) => entry.ratio >= 0 && entry.ratio <= 1)
    .sort((a, b) => a.ratio - b.ratio);

  const clusters: { ratio: number; members: TimelineEvent[] }[] = [];
  for (const entry of placed) {
    const last = clusters[clusters.length - 1];
    if (last && entry.ratio - last.ratio <= CLUSTER_RATIO) {
      last.members.push(entry.event);
      continue;
    }
    clusters.push({ ratio: entry.ratio, members: [entry.event] });
  }

  return (
    <div
      className="relative"
      style={{ height }}
      role="group"
      aria-label={t('chart.rail.summary', { label, count: events.length })}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-[13px] h-0.5 rounded-[1px] bg-border-subtle"
      />
      {clusters.map((cluster) => {
        const worst = cluster.members.reduce(
          (acc, member) => (TONE_RANK[member.tone] > TONE_RANK[acc] ? member.tone : acc),
          cluster.members[0]?.tone ?? 'idle',
        );
        const color = EVENT_COLOR[worst];
        const many = cluster.members.length > 1;
        const size = many ? 16 : 12;
        const title =
          cluster.members
            .slice(0, 6)
            .map((member) => member.title)
            .join('\n') +
          (cluster.members.length > 6
            ? `\n${t('chart.rail.more', { count: cluster.members.length - 6 })}`
            : '');
        return (
          <Tooltip
            key={`${cluster.ratio}-${cluster.members[0]?.key ?? ''}`}
            content={title}
            wide={many}
          >
            <span
              tabIndex={0}
              aria-label={title}
              className="absolute flex items-center justify-center rounded-full"
              style={{
                left: `${cluster.ratio * 100}%`,
                top: 14 - size / 2,
                width: size,
                height: size,
                marginLeft: -size / 2,
                background: color,
                border: '2px solid var(--surface)',
                boxShadow: `0 0 0 1px ${color}`,
              }}
            >
              {many ? (
                <span className="font-mono text-[9px] leading-none font-semibold text-surface">
                  {cluster.members.length}
                </span>
              ) : null}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ─── axe ──────────────────────────────────────────────────────────────────────

/**
 * L'axe du temps partagé par une pile de pistes, en temps relatif : « −24 h »,
 * « −18 h »… « maintenant ». On lit une distance à l'instant, pas une heure
 * d'horloge à convertir.
 */
export async function TimeAxis({
  from,
  to,
  ticks = 5,
}: {
  from: string;
  to: string;
  ticks?: number;
  /** Conservé pour l'API : l'axe relatif n'a plus d'heure à formater. */
  format?: FormatSettings;
}) {
  const t = await getT(chrome);
  const hours = (Date.parse(to) - Date.parse(from)) / 3_600_000;
  // Au-delà de trois jours on compte en jours entiers, une graduation par jour.
  const inDays = hours >= 72;
  const marks = inDays ? Math.round(hours / 24) + 1 : ticks;
  const labels = Array.from({ length: marks }, (_, index) => {
    if (index === marks - 1) return t('chart.axis.now');
    const ago = hours * (1 - index / (marks - 1));
    return inDays
      ? t('chart.axis.daysAgo', { days: Math.round(ago / 24) })
      : t('chart.axis.hoursAgo', { hours: Math.round(ago) });
  });
  return (
    <div className="axis" aria-hidden>
      {labels.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </div>
  );
}

// ─── états sans données ───────────────────────────────────────────────────────

/** Pas assez d'historique : on le dit, et on dit depuis quand on regarde. */
export async function NotEnoughHistory({
  covered,
  buckets,
  nothing,
  since,
  format,
  children,
}: {
  covered: number;
  buckets: number;
  nothing: string;
  since?: string | null;
  format: FormatSettings;
  children?: ReactNode;
}) {
  const t = await getT(chrome);
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-dashed border-border-strong bg-surface-2 px-3.5 py-2.5">
      <p className="t-sm text-text">{t('chart.history.title')}</p>
      <p className="t-cap text-text-3">
        {covered === 0
          ? t('chart.history.nothing', { nothing })
          : t('chart.history.covered', { count: covered, buckets }) +
            (since ? t('chart.history.oldest', { when: dayClock(since, format) }) : '.')}
      </p>
      {children}
    </div>
  );
}

// ─── petites formes ───────────────────────────────────────────────────────────

/**
 * Mini-jauge d'une ressource : « mém ▬ 62 % ». Graphite au repos, ambre au
 * seuil. Le chiffre est toujours écrit ; sans mesure, un tiret.
 */
export async function MiniGauge({
  value,
  label,
  warn = false,
}: {
  value: number | null;
  label: string;
  warn?: boolean;
  /** Conservé pour l'API : la teinte suit désormais `warn`. */
  tone?: string;
}) {
  const t = await getT(chrome);
  const measure =
    value === null
      ? t('chart.gauge.unmeasured')
      : t('chart.gauge.percent', { value: Math.round(value) });
  return (
    <span className={cn('mgauge', warn && 'is-warn')} title={`${label} — ${measure}`}>
      {label}
      <i aria-hidden>
        {value === null ? null : <b style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />}
      </i>
      <span className="num">{value === null ? '—' : `${Math.round(value)}%`}</span>
    </span>
  );
}

export { MicroSpark } from './spark';
