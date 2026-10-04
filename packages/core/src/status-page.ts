import { z } from 'zod';
import { invalid } from './validation.js';

/**
 * Public status pages: `/status`, `/status/<address>`.
 *
 * A page is a **list of blocks** the administrator composes and orders. This
 * module carries their shape (validated by Zod, the same on the editor side and
 * the API side) and the rules that turn a probe's internal state into what a
 * visitor can read. It **never** leaks out of a page: no probed URL, no error
 * message, no machine name — only the chosen labels, states and durations.
 */

/** An address: empty for `/status`, otherwise lowercase letters, digits and dashes. */
export const statusPageSlugSchema = z
  .string()
  .trim()
  .max(60)
  .regex(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/, 'minuscules, chiffres et tirets, sans tiret au bord');

/** A page's public path. */
export function statusPagePath(slug: string): string {
  return slug === '' ? '/status' : `/status/${slug}`;
}

export const STATUS_PAGE_MAX_BLOCKS = 30;
export const STATUS_PAGE_MAX_SERVICES = 50;
export const STATUS_PAGE_HISTORY_DAYS = 30;
export const STATUS_PAGE_INCIDENT_DAYS = [7, 14, 30] as const;

const blockId = z.string().min(1).max(64);

export const statusBlockSchema = z.discriminatedUnion('type', [
  /** The overall status band: "All services are operational". */
  z.object({ id: blockId, type: z.literal('summary') }),
  z.object({ id: blockId, type: z.literal('heading'), text: z.string().trim().min(1).max(120) }),
  /** Plain text; line breaks are kept, no HTML is interpreted. */
  z.object({ id: blockId, type: z.literal('text'), text: z.string().trim().min(1).max(2000) }),
  z.object({
    id: blockId,
    type: z.literal('services'),
    title: z.string().trim().max(120).nullable(),
    items: z
      .array(
        z.object({
          monitorId: z.string().uuid(),
          /** The public name; `null` reuses the probe's name. */
          label: z.string().trim().max(80).nullable(),
        }),
      )
      .min(1)
      .max(STATUS_PAGE_MAX_SERVICES),
    /** One bar per day over the last thirty days. */
    history: z.boolean(),
    /** The availability rate over the same period. */
    uptime: z.boolean(),
  }),
  /** The ongoing and upcoming maintenance windows that touch the page's services. */
  z.object({ id: blockId, type: z.literal('maintenance') }),
  /** The recent outages of the page's services. */
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
 * A page's fields, **without** default values. Those live in the creation
 * schema only: `.partial()` on a field carrying `.default()` fills it when it is
 * missing, and a `PATCH { title }` put the page back to draft, without a
 * description or blocks.
 */
const statusPageFields = z.object({
  slug: statusPageSlugSchema,
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable(),
  published: z.boolean(),
  blocks: z
    .array(statusBlockSchema)
    .max(STATUS_PAGE_MAX_BLOCKS)
    .refine(
      (blocks) => new Set(blocks.map((block) => block.id)).size === blocks.length,
      invalid('statusPage.duplicateBlocks'),
    ),
});

export const statusPageInputSchema = statusPageFields.extend({
  description: statusPageFields.shape.description.default(null),
  published: statusPageFields.shape.published.default(false),
  blocks: statusPageFields.shape.blocks.default([]),
});

export type StatusPageInput = z.infer<typeof statusPageInputSchema>;

export const updateStatusPageSchema = statusPageFields
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, invalid('nothingToChange'));

/** The probes a page shows, in block order, without duplicates. */
export function statusPageMonitorIds(blocks: readonly StatusBlock[]): string[] {
  const ids: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'services') continue;
    for (const item of block.items) if (!ids.includes(item.monitorId)) ids.push(item.monitorId);
  }
  return ids;
}

// ─── What a visitor reads ─────────────────────────────────────────────────────

export const PUBLIC_STATES = ['operational', 'degraded', 'down', 'maintenance', 'unknown'] as const;
export type PublicState = (typeof PUBLIC_STATES)[number];

/**
 * A probe's public state. A maintenance window wins: an intended outage reads
 * "under maintenance", not "down". A paused probe no longer measures anything:
 * its state is unknown, not "operational".
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
 * A page's overall state, from its services. Every outage counts: more than
 * half down is a major outage; up to half, partial — one service out of two is
 * not "everything is down".
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
 * One bar per day, from oldest to newest, over `days` days ending on `today`
 * ("YYYY-MM-DD", in the instance's time zone). A day without measurements stays
 * empty rather than being counted as "operational".
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

/** The availability rate over the period, as a percentage; `null` without measurements. */
export function uptimeOf(tallies: readonly DayTally[]): number | null {
  const total = tallies.reduce((sum, tally) => sum + tally.total, 0);
  if (total === 0) return null;
  const healthy = tallies.reduce((sum, tally) => sum + tally.healthy, 0);
  return (healthy / total) * 100;
}
