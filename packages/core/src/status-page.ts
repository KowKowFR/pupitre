import { z } from 'zod';

/**
 * Les pages de statut publiques : `/status`, `/status/<adresse>`.
 *
 * Une page est une **liste de blocs** que l'administrateur compose et ordonne.
 * Ce module porte leur forme (validée par Zod, la même côté éditeur et côté
 * API) et les règles qui transforment l'état interne d'une sonde en ce qu'un
 * visiteur peut lire. Il ne sort **jamais** d'une page : ni URL sondée, ni
 * message d'erreur, ni nom de machine — seulement les libellés choisis, des
 * états et des durées.
 */

/** Une adresse : vide pour `/status`, sinon des minuscules, des chiffres et des tirets. */
export const statusPageSlugSchema = z
  .string()
  .trim()
  .max(60)
  .regex(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/, 'minuscules, chiffres et tirets, sans tiret au bord');

/** Le chemin public d'une page. */
export function statusPagePath(slug: string): string {
  return slug === '' ? '/status' : `/status/${slug}`;
}

export const STATUS_PAGE_MAX_BLOCKS = 30;
export const STATUS_PAGE_MAX_SERVICES = 50;
export const STATUS_PAGE_HISTORY_DAYS = 30;
export const STATUS_PAGE_INCIDENT_DAYS = [7, 14, 30] as const;

const blockId = z.string().min(1).max(64);

export const statusBlockSchema = z.discriminatedUnion('type', [
  /** La bande d'état général : « Tous les services fonctionnent ». */
  z.object({ id: blockId, type: z.literal('summary') }),
  z.object({ id: blockId, type: z.literal('heading'), text: z.string().trim().min(1).max(120) }),
  /** Du texte brut ; les retours à la ligne sont gardés, aucun HTML n'est interprété. */
  z.object({ id: blockId, type: z.literal('text'), text: z.string().trim().min(1).max(2000) }),
  z.object({
    id: blockId,
    type: z.literal('services'),
    title: z.string().trim().max(120).nullable(),
    items: z
      .array(
        z.object({
          monitorId: z.string().uuid(),
          /** Le nom public ; `null` reprend le nom de la sonde. */
          label: z.string().trim().max(80).nullable(),
        }),
      )
      .min(1)
      .max(STATUS_PAGE_MAX_SERVICES),
    /** Une barre par jour sur les trente derniers jours. */
    history: z.boolean(),
    /** Le taux de disponibilité sur la même période. */
    uptime: z.boolean(),
  }),
  /** Les maintenances en cours et à venir qui touchent les services de la page. */
  z.object({ id: blockId, type: z.literal('maintenance') }),
  /** Les pannes récentes des services de la page. */
  z.object({
    id: blockId,
    type: z.literal('incidents'),
    days: z.union([z.literal(7), z.literal(14), z.literal(30)]),
  }),
]);

export type StatusBlock = z.infer<typeof statusBlockSchema>;
export type StatusBlockType = StatusBlock['type'];
export const STATUS_BLOCK_TYPES = [
  'summary',
  'heading',
  'text',
  'services',
  'maintenance',
  'incidents',
] as const satisfies readonly StatusBlockType[];

/**
 * Les champs d'une page, **sans** valeurs par défaut. Elles vivent dans le
 * schéma de création seulement : `.partial()` sur un champ porteur de
 * `.default()` le remplit quand il manque, et un `PATCH { title }` remettait
 * la page en brouillon, sans description ni blocs.
 */
const statusPageFields = z.object({
  slug: statusPageSlugSchema,
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable(),
  published: z.boolean(),
  blocks: z
    .array(statusBlockSchema)
    .max(STATUS_PAGE_MAX_BLOCKS)
    .refine((blocks) => new Set(blocks.map((block) => block.id)).size === blocks.length, {
      message: 'deux blocs portent le même identifiant',
    }),
});

export const statusPageInputSchema = statusPageFields.extend({
  description: statusPageFields.shape.description.default(null),
  published: statusPageFields.shape.published.default(false),
  blocks: statusPageFields.shape.blocks.default([]),
});

export type StatusPageInput = z.infer<typeof statusPageInputSchema>;

export const updateStatusPageSchema = statusPageFields
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'rien à modifier' });

/** Les sondes qu'une page montre, dans l'ordre des blocs, sans doublon. */
export function statusPageMonitorIds(blocks: readonly StatusBlock[]): string[] {
  const ids: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'services') continue;
    for (const item of block.items) if (!ids.includes(item.monitorId)) ids.push(item.monitorId);
  }
  return ids;
}

// ─── Ce qu'un visiteur lit ────────────────────────────────────────────────────

export const PUBLIC_STATES = ['operational', 'degraded', 'down', 'maintenance', 'unknown'] as const;
export type PublicState = (typeof PUBLIC_STATES)[number];

/**
 * L'état public d'une sonde. Une maintenance l'emporte : une panne voulue se
 * dit « en maintenance », pas « en panne ». Une sonde suspendue ne mesure plus
 * rien : son état est inconnu, pas « en service ».
 */
export function publicStateOf(monitor: {
  status: string;
  enabled: boolean;
  inMaintenance: boolean;
}): PublicState {
  if (monitor.inMaintenance) return 'maintenance';
  if (!monitor.enabled) return 'unknown';
  switch (monitor.status) {
    case 'healthy':
      return 'operational';
    case 'unhealthy':
      return 'degraded';
    case 'unreachable':
      return 'down';
    default:
      return 'unknown';
  }
}

export const OVERALL_STATES = [
  'operational',
  'degraded',
  'partial_outage',
  'major_outage',
  'maintenance',
  'unknown',
] as const;
export type OverallState = (typeof OVERALL_STATES)[number];

/**
 * L'état général d'une page, à partir de ses services. Toute panne compte :
 * plus de la moitié en panne, c'est une panne majeure ; jusqu'à la moitié,
 * partielle — un service sur deux n'est pas « tout est tombé ».
 */
export function overallStateOf(states: readonly PublicState[]): OverallState {
  if (states.length === 0) return 'unknown';
  const down = states.filter((state) => state === 'down').length;
  if (down > 0) return down * 2 > states.length ? 'major_outage' : 'partial_outage';
  if (states.includes('degraded')) return 'degraded';
  if (states.includes('maintenance')) return 'maintenance';
  if (states.every((state) => state === 'unknown')) return 'unknown';
  return 'operational';
}

export type DayTally = { day: string; total: number; healthy: number };
export type DayBar = {
  day: string;
  state: 'operational' | 'degraded' | 'down' | 'empty';
  ratio: number | null;
};

/**
 * Une barre par jour, du plus ancien au plus récent, sur `days` jours finissant
 * à `today` (« AAAA-MM-JJ », dans le fuseau de l'instance). Un jour sans mesure
 * reste vide plutôt que d'être compté « en service ».
 */
export function dayBars(tallies: readonly DayTally[], today: string, days: number): DayBar[] {
  const byDay = new Map(tallies.map((tally) => [tally.day, tally]));
  const end = Date.parse(`${today}T00:00:00Z`);
  const bars: DayBar[] = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    const day = new Date(end - index * 86_400_000).toISOString().slice(0, 10);
    const tally = byDay.get(day);
    if (!tally || tally.total === 0) {
      bars.push({ day, state: 'empty', ratio: null });
      continue;
    }
    const ratio = tally.healthy / tally.total;
    bars.push({
      day,
      ratio,
      state: ratio >= 0.995 ? 'operational' : ratio >= 0.95 ? 'degraded' : 'down',
    });
  }
  return bars;
}

/** Le taux de disponibilité sur la période, en pourcentage ; `null` sans mesure. */
export function uptimeOf(tallies: readonly DayTally[]): number | null {
  const total = tallies.reduce((sum, tally) => sum + tally.total, 0);
  if (total === 0) return null;
  const healthy = tallies.reduce((sum, tally) => sum + tally.healthy, 0);
  return (healthy / total) * 100;
}
