import type { ReactNode } from 'react';
import { getT } from '@/i18n/server';
import { chrome } from '@/i18n/messages/chrome';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Le vocabulaire graphique du pupitre.
 *
 * ── Pourquoi du SVG à la main plutôt qu'une bibliothèque ────────────────────
 * La question a été tranchée en mesurant. Recharts pèse 7,4 Mo décompressés et
 * tire derrière lui Redux Toolkit, react-redux, immer et un paquet d3 —
 * autrement dit une pile de gestion d'état complète, embarquée dans un produit
 * auto-hébergé, pour dessiner quatre figures. Chart.js coûte 6,2 Mo,
 * ApexCharts 21,5 Mo. uPlot est le seul poids raisonnable (545 Ko).
 *
 * Mais le poids n'est pas l'argument décisif. Toutes ces bibliothèques rendent
 * dans le navigateur : chaque figure deviendrait un composant client, et un
 * tableau de bord aujourd'hui **entièrement rendu sur le serveur** se mettrait
 * à hydrater. Les figures ci-dessous n'expédient pas une ligne de JavaScript —
 * ce sont des composants serveur, et le SVG arrive fini dans la page.
 *
 * Le prix payé est réel et il faut le nommer : pas d'infobulle riche, pas de
 * zoom, pas d'axes calculés tout seuls. La contrepartie est qu'on hérite du
 * système de jetons sans rien reproduire, et qu'on ne fait pas entrer un second
 * langage visuel dans un écran qui en a déjà un.
 *
 * ── Pourquoi aucun texte n'est dans le SVG ──────────────────────────────────
 * Les figures s'étirent en largeur à hauteur fixe, donc `preserveAspectRatio`
 * vaut `none` : un `<text>` posé dedans serait comprimé ou dilaté avec elles.
 * À 1024 px de fenêtre la zone utile ne fait que 712 px, soit une échelle
 * horizontale de 0,71 — les graduations auraient été visiblement écrasées.
 * Toutes les étiquettes sont donc en HTML, dans une gouttière de largeur fixe à
 * gauche et sur un axe sous la pile. Les figures partagent cette gouttière,
 * c'est ce qui les aligne au pixel.
 *
 * ── La règle qui gouverne ces figures ───────────────────────────────────────
 * **Un seau sans mesure ne se dessine pas comme un zéro.** Il reçoit un moignon
 * gris à la ligne de base, et il est compté à part. Un seau qui ne porte qu'une
 * ou deux mesures est hachuré : son taux vaut 0 % ou 100 % et rien entre les
 * deux, ce n'est pas une valeur, c'est un tirage. Une courbe plate sur deux
 * points ne doit jamais avoir l'air d'une stabilité.
 *
 * ── Accessibilité ───────────────────────────────────────────────────────────
 * Même contrat que `monitor-charts.tsx`, dont ces composants sont l'extension :
 * les couleurs sont les couleurs d'état du panel, jamais une palette
 * catégorielle ; chaque marque porte un `title` qui la nomme en toutes lettres ;
 * une légende nomme les teintes ; aucune valeur n'est enfermée derrière un
 * survol ; chaque figure est un `role="img"` avec un `aria-label` qui résume.
 */

// ─── géométrie partagée ───────────────────────────────────────────────────────

/**
 * Le `viewBox` horizontal des figures. Une valeur ronde et sans unité : le SVG
 * occupe toute la largeur restante, l'échelle réelle est décidée par le CSS.
 */
const VIEW = 1000;

/** Gouttière des graduations, en HTML. Toutes les pistes partagent la même. */
const GUTTER = 'w-10';

/** En deçà, un seau ne porte pas une mesure : il porte une anecdote. */
export const THIN_SAMPLES = 3;

export type Bucket = { at: string; samples: number };

/** Ce qu'on peut honnêtement faire d'une série. */
export type Verdict = 'none' | 'sparse' | 'ok';

/**
 * Le verdict de densité, calculé une fois et respecté partout.
 *
 * `sparse` n'est pas un échec : c'est l'état normal d'une instance jeune. Il
 * demande seulement que la figure soit accompagnée de sa réserve, au lieu
 * d'être lue comme une tendance.
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

/**
 * L'heure d'un seau, et la date-heure du plus ancien.
 *
 * Les composantes sont celles que la figure impose — une graduation d'axe n'a
 * la place que pour `14:32` —, mais la locale vient des paramètres d'instance
 * et descend par props comme le reste du formatage. Écrire `13/09 00:33` sur
 * un panel anglais était le dernier endroit où la langue de l'instance ne
 * décidait de rien.
 */
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

/**
 * Le châssis d'une piste : la gouttière des graduations à gauche, la figure à
 * droite. Les graduations sont posées en pourcentage de la hauteur, donc elles
 * suivent n'importe quelle hauteur de figure sans calcul dans l'appelant.
 */
function Plot({
  height,
  padTop,
  padBottom,
  ticks,
  children,
}: {
  height: number;
  padTop: number;
  padBottom: number;
  /** Du bas vers le haut : la fraction de l'échelle et son étiquette. */
  ticks: readonly { ratio: number; label: string }[];
  children: ReactNode;
}) {
  const usable = height - padTop - padBottom;
  return (
    <div className="flex items-stretch">
      <div className={cn('relative shrink-0', GUTTER)} style={{ height }} aria-hidden>
        {ticks.map((tick) => (
          <span
            key={tick.ratio}
            className="text-ink-faint absolute right-2 font-mono text-[0.625rem] tabular-nums"
            style={{ top: padTop + usable * (1 - tick.ratio), transform: 'translateY(-50%)' }}
          >
            {tick.label}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Les filets de l'échelle, dans le repère du SVG. */
function Grid({
  ticks,
  padTop,
  usable,
}: {
  ticks: readonly { ratio: number }[];
  padTop: number;
  usable: number;
}) {
  return (
    <>
      {ticks.map((tick) => (
        <line
          key={tick.ratio}
          x1={0}
          x2={VIEW}
          y1={padTop + usable * (1 - tick.ratio)}
          y2={padTop + usable * (1 - tick.ratio)}
          stroke="var(--line)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </>
  );
}

/**
 * La hachure des seaux trop maigres.
 *
 * Un motif et pas seulement une opacité réduite : l'opacité seule se confond
 * avec « une valeur plus faible », qui est exactement le contresens à éviter.
 * Une hachure ne ressemble à aucune donnée, donc elle se lit comme une réserve.
 */
function ThinHatch({ id, color }: { id: string; color: string }) {
  return (
    <defs>
      <pattern
        id={id}
        width={4}
        height={4}
        patternTransform="rotate(45)"
        patternUnits="userSpaceOnUse"
      >
        <rect width={4} height={4} fill={color} opacity={0.18} />
        <line x1={0} y1={0} x2={0} y2={4} stroke={color} strokeWidth={2} opacity={0.85} />
      </pattern>
    </defs>
  );
}

const PERCENT_TICKS = [
  { ratio: 0, label: '0' },
  { ratio: 0.5, label: '50' },
  { ratio: 1, label: '100' },
] as const;

// ─── barres par seau ──────────────────────────────────────────────────────────

export type RatioBucket = Bucket & {
  /** Numérateur. Sans dénominateur (`samples`), il ne veut rien dire. */
  hits: number;
};

/**
 * La part de mesures conformes, seau par seau — la figure de disponibilité.
 *
 * La barre est peinte selon le résultat, pas selon une palette : pleine et
 * verte quand tout le seau est sain, ambre dès qu'une mesure manque à l'appel,
 * rouge quand rien n'a répondu. Un seau sans mesure n'est pas peint du tout.
 */
export async function RatioBars({
  id,
  buckets,
  height = 74,
  label,
  unit,
  format,
}: {
  id: string;
  buckets: readonly RatioBucket[];
  height?: number;
  label: string;
  /** Ce que compte le numérateur, déjà traduit : « sain », « conforme »… */
  unit: string;
  format: FormatSettings;
}) {
  const t = await getT(chrome);
  const count = buckets.length;
  const padTop = 8;
  const padBottom = 6;
  const usable = height - padTop - padBottom;
  const band = count > 0 ? VIEW / count : VIEW;
  const barWidth = Math.max(2, band - 2);
  const density = densityOf(buckets);

  return (
    <Plot height={height} padTop={padTop} padBottom={padBottom} ticks={[...PERCENT_TICKS]}>
      <svg
        viewBox={`0 0 ${VIEW} ${height}`}
        className="w-full"
        style={{ height }}
        preserveAspectRatio="none"
        role="img"
        aria-label={t('chart.bars.summary', {
          label,
          covered: density.covered,
          total: count,
          samples: density.samples,
        })}
      >
        <ThinHatch id={`${id}-thin`} color="var(--ok)" />
        <Grid ticks={PERCENT_TICKS} padTop={padTop} usable={usable} />

        {buckets.map((bucket, index) => {
          const left = index * band + (band - barWidth) / 2;

          if (bucket.samples === 0) {
            // Le moignon de « rien mesuré ». Deux pixels à la ligne de base : on
            // voit qu'il s'est passé du temps, on ne lit aucune valeur.
            return (
              <rect
                key={bucket.at}
                x={left}
                y={padTop + usable - 2}
                width={barWidth}
                height={2}
                fill="var(--ink-faint)"
                opacity={0.35}
              >
                <title>{t('chart.bars.empty', { clock: clock(bucket.at, format) })}</title>
              </rect>
            );
          }

          const ratio = bucket.hits / bucket.samples;
          const thin = bucket.samples < THIN_SAMPLES;
          const tone = ratio === 1 ? 'var(--ok)' : ratio === 0 ? 'var(--danger)' : 'var(--warn)';
          const barHeight = Math.max(2, usable * ratio);

          return (
            <rect
              key={bucket.at}
              x={left}
              y={padTop + usable - barHeight}
              width={barWidth}
              height={barHeight}
              fill={thin && ratio === 1 ? `url(#${id}-thin)` : tone}
              opacity={thin && ratio !== 1 ? 0.5 : 1}
            >
              <title>
                {t('chart.bars.ratio', {
                  clock: clock(bucket.at, format),
                  hits: bucket.hits,
                  samples: bucket.samples,
                  unit,
                }) + (thin ? t('chart.bars.thin') : '')}
              </title>
            </rect>
          );
        })}
      </svg>
    </Plot>
  );
}

// ─── courbe sur seaux ─────────────────────────────────────────────────────────

export type SeriesBucket = Bucket & { value: number | null };

/**
 * Une grandeur continue suivie dans le temps — charge, latence, volume.
 *
 * Le trait se **coupe** dès qu'un seau n'a pas de mesure, et l'intervalle non
 * couvert est tramé. Relier les deux bords d'un trou dessinerait une droite qui
 * n'a jamais été observée, et c'est précisément là qu'un tableau de bord ment
 * le plus facilement : la ligne paraît continue, donc la surveillance paraît
 * continue.
 */
export async function SeriesLine({
  buckets,
  height = 96,
  label,
  max,
  unit = '',
  tone = 'var(--signal)',
  format,
}: {
  buckets: readonly SeriesBucket[];
  height?: number;
  label: string;
  /** Plafond de l'échelle. Fixé par l'appelant : une échelle qui bouge à chaque rendu ne se compare pas. */
  max: number;
  unit?: string;
  tone?: string;
  format: FormatSettings;
}) {
  const t = await getT(chrome);
  const count = buckets.length;
  const padTop = 8;
  const padBottom = 6;
  const usable = height - padTop - padBottom;
  const band = count > 0 ? VIEW / count : VIEW;
  const ceiling = Math.max(1, max);

  const at = (index: number) => index * band + band / 2;
  const toY = (value: number) => padTop + usable - (Math.min(value, ceiling) / ceiling) * usable;

  // Découpage en segments continus : chaque trou en ouvre un nouveau.
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

  const density = densityOf(buckets);
  const ticks = [
    { ratio: 0, label: '0' },
    { ratio: 0.5, label: String(Math.round(ceiling / 2)) },
    { ratio: 1, label: String(Math.round(ceiling)) },
  ];

  return (
    <Plot height={height} padTop={padTop} padBottom={padBottom} ticks={ticks}>
      <svg
        viewBox={`0 0 ${VIEW} ${height}`}
        className="w-full"
        style={{ height }}
        preserveAspectRatio="none"
        role="img"
        aria-label={t('chart.series.summary', {
          label,
          covered: density.covered,
          total: count,
        })}
      >
        <Grid ticks={ticks} padTop={padTop} usable={usable} />

        {/* Les intervalles non couverts, trames et non laissés vides : un blanc
            se lit comme « zéro », une trame se lit comme « pas regardé ». */}
        {buckets.map((bucket, index) =>
          bucket.samples === 0 ? (
            <rect
              key={`void-${bucket.at}`}
              x={index * band}
              y={padTop}
              width={band}
              height={usable}
              fill="var(--ink-faint)"
              opacity={0.09}
            >
              <title>{t('chart.series.void', { clock: clock(bucket.at, format) })}</title>
            </rect>
          ) : null,
        )}

        {runs.map((segment) => {
          const first = segment[0];
          const last = segment[segment.length - 1];
          if (!first || !last) return null;
          const line = segment
            .map((point, i) => `${i === 0 ? 'M' : 'L'}${at(point.index)} ${toY(point.value)}`)
            .join(' ');
          const area = `${line} L${at(last.index)} ${padTop + usable} L${at(first.index)} ${padTop + usable} Z`;
          return (
            <g key={`run-${first.index}`}>
              {segment.length > 1 ? <path d={area} fill={tone} opacity={0.12} /> : null}
              <path
                d={line}
                fill="none"
                stroke={tone}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
              {/* Un point isolé n'a pas de trait : on dessine la mesure
                  elle-même, sinon elle disparaîtrait de la figure. */}
              {segment.length === 1 ? (
                <circle cx={at(first.index)} cy={toY(first.value)} r={3} fill={tone} />
              ) : null}
            </g>
          );
        })}

        {buckets.map((bucket, index) =>
          bucket.value === null ? null : (
            <rect
              key={`hit-${bucket.at}`}
              x={index * band}
              y={padTop}
              width={band}
              height={usable}
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
    </Plot>
  );
}

// ─── rail d'événements ────────────────────────────────────────────────────────

export type TimelineEvent = {
  key: string;
  at: string;
  tone: 'ok' | 'warn' | 'danger' | 'signal' | 'idle';
  title: string;
};

const EVENT_COLOR: Record<TimelineEvent['tone'], string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  signal: 'var(--signal)',
  idle: 'var(--ink-faint)',
};

/** Du plus anodin au plus grave — sert à colorer un amas par son pire élément. */
const TONE_RANK: Record<TimelineEvent['tone'], number> = {
  idle: 0,
  ok: 1,
  signal: 2,
  warn: 3,
  danger: 4,
};

/** Écart relatif sous lequel deux marques se confondraient (1 % de la largeur). */
const CLUSTER_RATIO = 0.012;

/**
 * Les événements ponctuels posés sur le même axe que les courbes.
 *
 * C'est ce rail qui rend la bande lisible : on voit *que* le déploiement de
 * 00 h 33 tombe dans le creux de charge de 00 h 33, sans avoir à croiser deux
 * écrans. Un événement est un instant, jamais un seau — il garde sa position
 * exacte, et on ne l'arrondit pas à l'heure pour faire joli.
 *
 * ── Les amas ────────────────────────────────────────────────────────────────
 * Six déploiements lancés en trois minutes tombent au même endroit. Les
 * dessiner l'un sur l'autre affichait *une* marque et prétendait qu'il s'était
 * passé une chose. Les marques trop proches sont donc réunies, comptées, et la
 * pastille porte le nombre : c'est la seule façon de rester exact sans mentir
 * sur la position. La couleur de l'amas est celle de son événement le plus
 * grave — un repli au milieu de cinq réussites doit se voir.
 *
 * En HTML et non en SVG : la pastille porte un chiffre, et un chiffre dans une
 * figure étirée en largeur serait déformé.
 */
export async function EventRail({
  events,
  from,
  to,
  height = 30,
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
    <div className="flex items-stretch">
      <div className={cn('shrink-0', GUTTER)} aria-hidden />
      <div
        className="relative min-w-0 flex-1"
        style={{ height }}
        role="img"
        aria-label={t('chart.rail.summary', { label, count: events.length })}
      >
        <span aria-hidden className="bg-line absolute inset-x-0 top-1/2 h-px" />
        {clusters.map((cluster) => {
          const worst = cluster.members.reduce(
            (acc, member) => (TONE_RANK[member.tone] > TONE_RANK[acc] ? member.tone : acc),
            cluster.members[0]?.tone ?? 'idle',
          );
          const color = EVENT_COLOR[worst];
          const many = cluster.members.length > 1;
          const size = many ? 15 : 9;

          return (
            <span
              key={`${cluster.ratio}-${cluster.members[0]?.key ?? ''}`}
              className="absolute top-1/2 flex items-center justify-center rounded-full"
              style={{
                left: `${cluster.ratio * 100}%`,
                width: size,
                height: size,
                marginLeft: -size / 2,
                marginTop: -size / 2,
                backgroundColor: color,
              }}
              title={
                cluster.members
                  .slice(0, 6)
                  .map((member) => member.title)
                  .join('\n') +
                (cluster.members.length > 6
                  ? `\n${t('chart.rail.more', { count: cluster.members.length - 6 })}`
                  : '')
              }
            >
              {many ? (
                <span className="text-card font-mono text-[0.5625rem] leading-none font-semibold">
                  {cluster.members.length}
                </span>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ─── axe des temps ────────────────────────────────────────────────────────────

/**
 * L'axe partagé, sous la pile de figures.
 *
 * Il reprend exactement la gouttière des pistes, donc ses graduations tombent
 * sur les mêmes abscisses que les barres et les courbes au-dessus.
 */
export async function TimeAxis({
  from,
  to,
  ticks = 5,
  format,
}: {
  from: string;
  to: string;
  ticks?: number;
  format: FormatSettings;
}) {
  const t = await getT(chrome);
  const start = Date.parse(from);
  const end = Date.parse(to);
  const marks = Array.from({ length: ticks }, (_, i) => {
    const ratio = i / (ticks - 1);
    return { ratio, at: new Date(start + (end - start) * ratio).toISOString() };
  });

  return (
    <div className="flex items-stretch" aria-hidden>
      <div className={cn('shrink-0', GUTTER)} />
      <div className="relative h-4 min-w-0 flex-1">
        {marks.map((mark, index) => (
          <span
            key={mark.at}
            className="text-ink-faint absolute top-0 font-mono text-[0.625rem] whitespace-nowrap"
            style={{
              left: `${mark.ratio * 100}%`,
              transform:
                index === 0
                  ? 'none'
                  : index === marks.length - 1
                    ? 'translateX(-100%)'
                    : 'translateX(-50%)',
            }}
          >
            {index === marks.length - 1 ? t('chart.axis.now') : clock(mark.at, format)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── réserves et légendes ─────────────────────────────────────────────────────

/**
 * L'état « pas encore assez d'historique ».
 *
 * Il occupe la place de la figure au lieu de la laisser vide, et il dit
 * *combien* il manque. « Aucune donnée » laisserait croire à une panne de
 * collecte ; « 4 intervalles mesurés sur 24 » dit que la collecte marche et
 * qu'elle vient de commencer.
 */
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
  /**
   * La phrase de manque, article compris et déjà traduite : « Aucune mesure de
   * sonde », « Aucun relevé machine ». C'est l'appelant qui l'écrit en entier
   * parce que le français accorde l'article au genre du nom, et qu'un « Aucun »
   * collé devant un nom féminin par un gabarit se voit tout de suite.
   */
  nothing: string;
  since?: string | null;
  format: FormatSettings;
  children?: ReactNode;
}) {
  const t = await getT(chrome);
  return (
    <div className="border-line bg-surface-2/40 flex flex-col gap-1 rounded-md border border-dashed px-4 py-3">
      <p className="text-ink text-[0.8125rem]">{t('chart.history.title')}</p>
      <p className="text-ink-faint text-xs">
        {covered === 0
          ? t('chart.history.nothing', { nothing })
          : t('chart.history.covered', { count: covered, buckets }) +
            (since ? t('chart.history.oldest', { when: dayClock(since, format) }) : '.')}
      </p>
      {children}
    </div>
  );
}

/**
 * La phrase de couverture, sous une figure qu'on a quand même tracée.
 *
 * Elle est obligatoire dès qu'un seau est maigre ou manquant : la figure seule
 * ne peut pas dire « j'ai regardé une fois pendant cette heure-là ».
 */
export async function CoverageNote({
  covered,
  buckets,
  thin,
  samples,
  what,
  className,
}: {
  covered: number;
  buckets: number;
  thin: number;
  samples: number;
  /**
   * Ce qui a été compté. Un mot-clé, pas une chaîne : une sonde prend des
   * *mesures*, un balayage écrit des *relevés*, et les deux ne s'accordent pas
   * pareil. L'appelant nomme la nature du compte, le dictionnaire accorde.
   */
  what: 'sample' | 'readout';
  className?: string;
}) {
  const t = await getT(chrome);
  const parts: string[] = [
    t(what === 'sample' ? 'chart.coverage.sample' : 'chart.coverage.readout', {
      count: samples,
      covered,
      buckets,
    }),
  ];
  if (thin > 0) {
    // Formulation neutre : toutes les figures ne hachurent pas — une courbe ne
    // peut pas. Ce qui compte est le fait, pas la façon dont il est dessiné.
    parts.push(t('chart.coverage.thin', { count: thin, min: THIN_SAMPLES }));
  }
  if (covered < buckets) parts.push(t('chart.coverage.missing', { count: buckets - covered }));
  return <p className={cn('text-ink-faint text-[0.6875rem]', className)}>{parts.join(' · ')}</p>;
}

/** Légende nommant les teintes. La couleur seule ne porte jamais l'information. */
export function ChartLegend({
  items,
  className,
}: {
  items: readonly { color: string; label: string; hatched?: boolean }[];
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
      {items.map((item) => (
        <span
          key={item.label}
          className="text-ink-faint inline-flex items-center gap-1.5 text-[0.6875rem]"
        >
          <span
            aria-hidden
            className="inline-block h-2.5 w-1.5 rounded-[1px]"
            style={
              item.hatched
                ? {
                    backgroundImage: `repeating-linear-gradient(45deg, ${item.color} 0 1px, transparent 1px 3px)`,
                    backgroundColor: `color-mix(in oklab, ${item.color} 18%, transparent)`,
                  }
                : { backgroundColor: item.color }
            }
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Une jauge horizontale compacte — sert aux relevés par machine.
 *
 * `null` n'est pas 0 : sans mesure, la jauge reste vide avec un tiret, elle ne
 * dessine pas une barre à zéro qui se lirait « disque vide ».
 */
export async function MiniGauge({
  value,
  label,
  tone = 'var(--signal)',
}: {
  value: number | null;
  label: string;
  tone?: string;
}) {
  const t = await getT(chrome);
  const measure =
    value === null
      ? t('chart.gauge.unmeasured')
      : t('chart.gauge.percent', { value: Math.round(value) });
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={`${label} — ${measure}`}>
      <span className="eyebrow text-ink-faint shrink-0">{label}</span>
      <span className="bg-surface-3 relative h-1.5 w-9 shrink-0 overflow-hidden rounded-full">
        {value === null ? null : (
          <span
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${Math.max(2, Math.min(100, value))}%`, backgroundColor: tone }}
          />
        )}
      </span>
      <span className="text-ink-muted shrink-0 font-mono text-[0.6875rem] tabular-nums">
        {value === null ? '—' : `${Math.round(value)}%`}
      </span>
    </span>
  );
}

/**
 * Micro-courbe sans axe, pour une ligne de liste.
 *
 * Elle n'a délibérément pas d'échelle : elle ne sert qu'à montrer une *forme*,
 * et le chiffre lisible est toujours à côté d'elle. C'est la seule figure de ce
 * fichier qui a le droit de s'en passer, parce qu'elle ne prétend à rien.
 */
export function MicroSpark({
  values,
  width = 56,
  height = 16,
  tone = 'var(--signal)',
  max,
}: {
  values: readonly (number | null)[];
  width?: number;
  height?: number;
  tone?: string;
  max: number;
}) {
  const points = values
    .map((value, index) => ({ value, index }))
    .filter((point): point is { value: number; index: number } => point.value !== null);
  if (points.length === 0) return null;

  const ceiling = Math.max(1, max);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const toY = (value: number) => height - 1 - (Math.min(value, ceiling) / ceiling) * (height - 2);

  if (points.length === 1) {
    const only = points[0];
    if (!only) return null;
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
        <circle cx={Math.max(2, only.index * step)} cy={toY(only.value)} r={2} fill={tone} />
      </svg>
    );
  }

  const d = points
    .map((point, i) => `${i === 0 ? 'M' : 'L'}${point.index * step} ${toY(point.value)}`)
    .join(' ');

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <path
        d={d}
        fill="none"
        stroke={tone}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
