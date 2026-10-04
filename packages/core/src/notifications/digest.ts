import {
  DEFAULT_UI_LANGUAGE,
  UI_LANGUAGES,
  renderMessage,
  type Translated,
  type UiLanguage,
  type Vars,
} from '../i18n.js';
import { z } from 'zod';
import {
  notificationSeverityLabel,
  notificationSeveritySchema,
  type NotificationSeverity,
} from './message.js';

/**
 * Grouping — the trade-off between *warning fast* and *warning little*.
 *
 * ── The problem, which is not deduplication's ───────────────────────────────
 * `notificationDedupKey()` prevents the **same** event replayed by BullMQ from
 * producing three messages. It says nothing about fifty *different* events in
 * ten minutes: fifty failed deployments, fifty messages, and an operator who
 * turns the notification off. Nobody disables an alert because it is
 * imprecise; one disables it because it is noisy.
 *
 * ── The rule chosen: first message immediate, then a widening window ────────
 * An isolated incident has no reason to wait: a group's first alert goes out
 * **without delay**, exactly as before. What it does on top is **open a
 * window**. While that window is open, the group's events no longer go out:
 * they are held, named, in the database. When it closes:
 *
 *   — nothing was held → the window closes and the group becomes "quiet" again:
 *     the next incident will go out immediately. An isolated outage therefore
 *     costs exactly one message, without latency;
 *   — something was held → a **digest** goes out, naming each held event, and a
 *     new window opens, **twice as long** as the previous one (up to ×8). A
 *     lasting storm therefore lowers the rate by itself, without an arbitrary
 *     threshold to set.
 *
 * In other words, the rate is bounded by the window and not by the incident
 * flow: fifty outages in ten minutes fit in one immediate message plus two or
 * three digests, whatever the number of outages.
 *
 * ── What the digest must say ────────────────────────────────────────────────
 * A mute counter is a loss of information disguised as a feature. A digest
 * therefore carries the **named list** of what it replaces (`items`), the total
 * held (`count`, which can exceed the list when the hard cap is reached), the
 * window's bounds, and the next one's duration. The channel decides the length
 * it can show — an email lists everything, a Telegram message stops at a few
 * lines and **says** how many it left out.
 *
 * ── Why a separate type and not a patched-up `NotificationMessage` ──────────
 * A digest does not have the shape of a single alert: it has a list, a window, a
 * total. Squeezing it into `fields` — meant for a few label/value pairs — would
 * force each channel to guess, from a text field, that it must render a list. It
 * is exactly the abstraction leak `message.ts` forbids. Hence a second neutral
 * type, and a second method on `NotificationChannel`.
 */

// ─── the digest's words ───────────────────────────────────────────────────────

/**
 * A digest explains its own trade-off: why one message rather than fifty, what
 * it names, what it leaves out, and when the next one arrives. These sentences
 * are the value of the mechanism — a mute counter would need no translation.
 */
const fr = {
  'title': '{count} × {label} — résumé',
  'count': {
    one: '{count} alerte « {label} » se sont produites entre {start} et {end} (UTC).',
    other: '{count} alertes « {label} » se sont produites entre {start} et {end} (UTC).',
  },
  'window':
    "La première d'entre elles est partie seule, sans attendre ; celles-ci ont été " +
    'retenues pendant la fenêtre de regroupement de {duration} ' +
    'pour ne pas produire {count} messages.',
  'named.all': 'Elles sont toutes nommées ci-dessous.',
  'named.partial':
    '{named} sont nommées ci-dessous, {omitted} ne le sont pas — la liste ' +
    'est bornée à {limit} lignes.',
  'next.widened':
    "L'orage continue : la fenêtre passe à {duration}. " +
    'Le prochain résumé arrivera dans ce délai au plus tard.',
  'next.same': 'Prochain résumé dans {duration} au plus tard.',
  'quiet':
    'Dès qu’une fenêtre se referme sans rien avoir retenu, la prochaine alerte repart immédiatement.',
  'omission': {
    one: '… et {count} autre, non détaillé ici.',
    other: '… et {count} autres, non détaillés ici.',
  },
} as const;

const en: Translated<typeof fr> = {
  'title': '{count} × {label} — digest',
  'count': {
    one: '{count} “{label}” alert fired between {start} and {end} (UTC).',
    other: '{count} “{label}” alerts fired between {start} and {end} (UTC).',
  },
  'window':
    'The first one went out on its own, with no delay; these were held during the ' +
    '{duration} grouping window so as not to produce {count} messages.',
  'named.all': 'They are all named below.',
  'named.partial':
    '{named} are named below, {omitted} are not — the list is capped at {limit} lines.',
  'next.widened':
    'The storm is still on: the window widens to {duration}. The next digest arrives ' +
    'within that delay at the latest.',
  'next.same': 'Next digest within {duration} at the latest.',
  'quiet': 'As soon as a window closes having held nothing, the next alert goes out at once.',
  'omission': {
    one: '… and {count} more, not detailed here.',
    other: '… and {count} more, not detailed here.',
  },
};

const DIGEST_TEXT = { fr, en };

function t(language: UiLanguage, key: keyof typeof fr, vars?: Vars): string {
  return renderMessage(DIGEST_TEXT, language, key, vars);
}

// ─── policy ───────────────────────────────────────────────────────────────────

/** Five minutes: enough for a storm to show, short enough to stay useful. */
export const NOTIFICATION_DIGEST_WINDOW_MS_DEFAULT = 5 * 60_000;

/**
 * The setting's bounds. The floor is **not** zero, and that is the point: a
 * volume guard that can be disabled is a guard disabled at the first annoyance.
 * The window can be shortened, never removed.
 */
export const NOTIFICATION_DIGEST_WINDOW_MS_MIN = 15_000;
export const NOTIFICATION_DIGEST_WINDOW_MS_MAX = 6 * 3_600_000;

/** Three doublings at most: the window never exceeds eight times its base. */
export const NOTIFICATION_DIGEST_MAX_ESCALATION = 3;

/**
 * Number of **named** events kept per window.
 *
 * Beyond that, the counter goes on but the line is no longer stored: a digest
 * of five thousand lines is no more readable than a counter, and it would grow
 * the table without anybody reading the thousandth name. The digest then says
 * how many lines it left out.
 */
export const NOTIFICATION_DIGEST_ITEM_LIMIT = 100;

/** Interval of the sweep that closes the due windows. See the worker's `main.ts`. */
export const NOTIFICATION_DIGEST_SWEEP_EVERY_MS = 5_000;

export const notificationDigestWindowMsSchema = z
  .number()
  .int()
  .min(NOTIFICATION_DIGEST_WINDOW_MS_MIN)
  .max(NOTIFICATION_DIGEST_WINDOW_MS_MAX);

/** The window's duration after `escalation` non-empty closings in a row. */
export function notificationDigestWindowMs(baseMs: number, escalation: number): number {
  const steps = Math.max(0, Math.min(escalation, NOTIFICATION_DIGEST_MAX_ESCALATION));
  return Math.min(baseMs * 2 ** steps, NOTIFICATION_DIGEST_WINDOW_MS_MAX);
}

/**
 * Grouping key.
 *
 * It is **the event**, and nothing finer. Grouping by application or by target
 * would make each line more precise but bring the problem back: an
 * infrastructure outage breaking fifty applications would produce fifty groups,
 * hence fifty messages. Precision belongs to the digest's *content* — each line
 * names its application —, not to the key.
 *
 * A second, structural benefit: channels subscribe **per event**. A key modeled
 * on the event guarantees that a digest goes exactly to the channels that would
 * have received the single alerts it replaces.
 */
export function notificationDigestGroupKey(event: string): string {
  return event;
}

// ─── the digest message ───────────────────────────────────────────────────────

/**
 * A digest line. `label` is the type's reason for being: it is what keeps the
 * digest from being a counter. It names the object concerned — a deployment, an
 * account —, not the category, which is already in the title.
 */
export const notificationDigestItemSchema = z.object({
  occurredAt: z.string().datetime(),
  label: z.string().trim().min(1).max(200),
  /** A short detail: the failed step, the scan's verdict. */
  detail: z.string().trim().min(1).max(300).nullable().default(null),
  url: z.string().url().max(500).nullable().default(null),
});

export type NotificationDigestItem = z.infer<typeof notificationDigestItemSchema>;

export const notificationDigestSchema = z.object({
  /** Discriminant: a channel must never confuse a digest and an alert. */
  type: z.literal('digest'),
  event: z.string().min(1).max(80),
  severity: notificationSeveritySchema,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(2000),
  /** What the digest replaces, named. At most `NOTIFICATION_DIGEST_ITEM_LIMIT`. */
  items: z.array(notificationDigestItemSchema).min(1).max(NOTIFICATION_DIGEST_ITEM_LIMIT),
  /** Total held over the window. Greater than `items.length` when the cap bit. */
  count: z.number().int().min(1),
  windowStartedAt: z.string().datetime(),
  windowEndedAt: z.string().datetime(),
  /** Duration of the window closing, then of the one opening. */
  windowMs: z.number().int().positive(),
  nextWindowMs: z.number().int().positive(),
  url: z.string().url().max(500).nullable().default(null),
  instance: z.string().trim().min(1).max(60),
  occurredAt: z.string().datetime(),
  /** Composition language. The same pattern as on `notificationMessageSchema`. */
  language: z.enum(UI_LANGUAGES).default(DEFAULT_UI_LANGUAGE),
});

export type NotificationDigest = z.infer<typeof notificationDigestSchema>;

/** Lines left out for lack of room in the capped storage. */
export function notificationDigestOmitted(digest: NotificationDigest): number {
  return Math.max(0, digest.count - digest.items.length);
}

// ─── shared formatting ────────────────────────────────────────────────────────

/**
 * "15 s", "5 min", "1 h 20". A readable duration, not an ISO 8601.
 *
 * Without a dictionary, and it is not an oversight: `s`, `min` and `h` are the
 * same symbols in both languages. Running them through a translation would add a
 * language to carry to render exactly the same string.
 */
export function formatDigestDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest}`;
}

/** `10:02:11` — the time alone, in UTC, as the ISO already carries it. */
export function digestTimeOfDay(iso: string): string {
  return iso.length >= 19 ? iso.slice(11, 19) : iso;
}

/**
 * A digest line in plain text. It lives here and not in each channel: it is the
 * *neutral type*'s rendering, without protocol, and three copies would end up
 * diverging.
 */
export function renderDigestItemLine(item: NotificationDigestItem): string {
  return `${digestTimeOfDay(item.occurredAt)} — ${item.label}${item.detail ? ` — ${item.detail}` : ''}`;
}

/**
 * The sentence **every** channel must render when it truncates the list.
 * Without it, ten lines shown out of fifty held are a lie by omission.
 */
export function renderDigestOmission(
  omitted: number,
  language: UiLanguage = DEFAULT_UI_LANGUAGE,
): string | null {
  if (omitted <= 0) return null;
  return t(language, 'omission', { count: omitted });
}

/**
 * Complete text rendering, shared by the channels that need it (an email's
 * `text/plain` part, the fallback of a channel without markup).
 *
 * `maxItems` caps the list — a short channel passes 5, an email passes nothing.
 */
export function renderDigestPlainText(digest: NotificationDigest, maxItems?: number): string {
  const shown = maxItems === undefined ? digest.items : digest.items.slice(0, maxItems);
  const omitted = digest.count - shown.length;

  const lines = [digest.title, '', digest.body, ''];
  for (const item of shown) lines.push(`• ${renderDigestItemLine(item)}`);

  const omission = renderDigestOmission(omitted, digest.language);
  if (omission) lines.push(omission);

  if (digest.url) lines.push('', digest.url);

  lines.push(
    '',
    `— ${digest.instance} · ${notificationSeverityLabel(digest.severity, digest.language).toLowerCase()} · ${digest.occurredAt}`,
  );

  return lines.join('\n');
}

// ─── composition ──────────────────────────────────────────────────────────────

export type BuildNotificationDigestInput = {
  event: string;
  severity: NotificationSeverity;
  /** The event's label in the catalog, e.g. "Deployment failed". */
  eventLabel: string;
  items: NotificationDigestItem[];
  /** Total kept, storage bound included. */
  count: number;
  windowStartedAt: string;
  windowEndedAt: string;
  windowMs: number;
  nextWindowMs: number;
  instance: string;
  /** The panel's root, without a trailing slash. `null` if unknown. */
  panelUrl: string | null;
  /** Path of the panel that shows these objects, e.g. `/deployments`. */
  path: string | null;
  /**
   * The instance's language. Resolved by the worker, which read the settings —
   * the `eventLabel` above must come from the same language.
   */
  language: UiLanguage;
};

/**
 * Composes the neutral digest. No protocol is known here — the same rule as
 * `buildNotificationMessage()`.
 *
 * The body **explains the trade-off** rather than suffering it: it says the
 * first alert went out on its own, how many events were held, over which window,
 * and when the next digest will arrive. An operator who receives a digest must
 * understand why they get one rather than ten.
 */
export function buildNotificationDigest(
  input: BuildNotificationDigestInput,
): NotificationDigest {
  const omitted = Math.max(0, input.count - input.items.length);
  const base = input.panelUrl?.replace(/\/+$/, '') ?? null;
  const widened = input.nextWindowMs > input.windowMs;

  const lang = input.language;

  const sentences = [
    t(lang, 'count', {
      count: input.count,
      label: input.eventLabel,
      start: digestTimeOfDay(input.windowStartedAt),
      end: digestTimeOfDay(input.windowEndedAt),
    }),
    t(lang, 'window', {
      duration: formatDigestDuration(input.windowMs),
      count: input.count,
    }),
    omitted > 0
      ? t(lang, 'named.partial', {
          named: input.items.length,
          omitted,
          limit: NOTIFICATION_DIGEST_ITEM_LIMIT,
        })
      : t(lang, 'named.all'),
    widened
      ? t(lang, 'next.widened', { duration: formatDigestDuration(input.nextWindowMs) })
      : t(lang, 'next.same', { duration: formatDigestDuration(input.nextWindowMs) }),
    t(lang, 'quiet'),
  ];

  return notificationDigestSchema.parse({
    type: 'digest',
    event: input.event,
    severity: input.severity,
    title: t(lang, 'title', { count: input.count, label: input.eventLabel }),
    body: sentences.join(' '),
    items: input.items.slice(0, NOTIFICATION_DIGEST_ITEM_LIMIT),
    count: input.count,
    windowStartedAt: input.windowStartedAt,
    windowEndedAt: input.windowEndedAt,
    windowMs: input.windowMs,
    nextWindowMs: input.nextWindowMs,
    url: base && input.path ? `${base}${input.path}` : null,
    instance: input.instance,
    occurredAt: input.windowEndedAt,
    language: lang,
  });
}
