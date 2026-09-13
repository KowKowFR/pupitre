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
 * Le regroupement — l'arbitrage entre *prévenir vite* et *prévenir peu*.
 *
 * ── Le problème, qui n'est pas celui du dédoublonnage ────────────────────────
 * `notificationDedupKey()` empêche qu'un **même** événement rejoué par BullMQ
 * produise trois messages. Il ne dit rien de cinquante événements *différents*
 * en dix minutes : cinquante déploiements en échec, cinquante messages, et un
 * opérateur qui coupe la notification. Personne ne désactive une alerte parce
 * qu'elle est imprécise ; on la désactive parce qu'elle est bruyante.
 *
 * ── La règle retenue : premier message immédiat, puis fenêtre qui s'élargit ──
 * Un incident isolé n'a aucune raison d'attendre : la première alerte d'un
 * groupe part **sans délai**, exactement comme avant. Ce qu'elle fait en plus,
 * c'est **ouvrir une fenêtre**. Tant que cette fenêtre est ouverte, les
 * événements du même groupe ne partent plus : ils sont retenus, nommés, en
 * base. À la fermeture :
 *
 *   — rien n'a été retenu → la fenêtre se referme et le groupe redevient
 *     « silencieux » : le prochain incident repartira immédiatement. Une panne
 *     isolée coûte donc exactement un message, sans latence ;
 *   — quelque chose a été retenu → un **résumé** part, qui nomme chaque
 *     événement retenu, et une nouvelle fenêtre s'ouvre, **deux fois plus
 *     longue** que la précédente (jusqu'à ×8). L'orage qui dure fait donc
 *     baisser la cadence tout seul, sans seuil arbitraire à régler.
 *
 * Autrement dit, la cadence est bornée par la fenêtre et non par le débit
 * d'incidents : cinquante pannes en dix minutes tiennent en un message immédiat
 * plus deux ou trois résumés, quel que soit le nombre de pannes.
 *
 * ── Ce que le résumé doit dire ───────────────────────────────────────────────
 * Un compteur muet est une perte d'information déguisée en fonctionnalité. Un
 * résumé porte donc la **liste nommée** de ce qu'il remplace (`items`), le
 * total retenu (`count`, qui peut dépasser la liste quand la borne dure est
 * atteinte), les bornes de la fenêtre, et la durée de la prochaine. Le canal
 * décide de la longueur qu'il peut afficher — un e-mail liste tout, un message
 * Telegram s'arrête à quelques lignes et **dit** combien il en a tues.
 *
 * ── Pourquoi un type à part et non un `NotificationMessage` bricolé ──────────
 * Un résumé n'a pas la forme d'une alerte unitaire : il a une liste, une
 * fenêtre, un total. Le faire entrer dans `fields` — prévu pour quelques
 * paires étiquette/valeur — obligerait chaque canal à deviner, à partir d'un
 * champ de texte, qu'il doit rendre une liste. C'est exactement la fuite
 * d'abstraction que `message.ts` interdit. D'où un second type neutre, et une
 * seconde méthode sur `NotificationChannel`.
 */

// ─── les mots du résumé ───────────────────────────────────────────────────────

/**
 * Un résumé explique son propre arbitrage : pourquoi un message plutôt que
 * cinquante, ce qu'il nomme, ce qu'il tait, et quand arrive le suivant. Ces
 * phrases-là sont la valeur du dispositif — un compteur muet n'aurait besoin
 * d'aucune traduction.
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

// ─── politique ────────────────────────────────────────────────────────────────

/** Cinq minutes : assez pour qu'un orage se manifeste, assez court pour rester utile. */
export const NOTIFICATION_DIGEST_WINDOW_MS_DEFAULT = 5 * 60_000;

/**
 * Bornes du réglage. Le plancher n'est **pas** zéro, et c'est le point : un
 * garde-fou de volume qu'on peut désactiver est un garde-fou qu'on désactive à
 * la première contrariété. On peut raccourcir la fenêtre, jamais la supprimer.
 */
export const NOTIFICATION_DIGEST_WINDOW_MS_MIN = 15_000;
export const NOTIFICATION_DIGEST_WINDOW_MS_MAX = 6 * 3_600_000;

/** Trois doublements au plus : la fenêtre ne dépasse jamais huit fois sa base. */
export const NOTIFICATION_DIGEST_MAX_ESCALATION = 3;

/**
 * Nombre d'événements **nommés** conservés par fenêtre.
 *
 * Au-delà, le compteur continue mais la ligne n'est plus stockée : un résumé de
 * cinq mille lignes n'est pas plus lisible qu'un compteur, et il ferait grossir
 * la table sans que personne ne lise le millième nom. Le résumé dit alors
 * combien de lignes il a tues.
 */
export const NOTIFICATION_DIGEST_ITEM_LIMIT = 100;

/** Cadence du balayage qui ferme les fenêtres échues. Voir `main.ts` du worker. */
export const NOTIFICATION_DIGEST_SWEEP_EVERY_MS = 5_000;

export const notificationDigestWindowMsSchema = z
  .number()
  .int()
  .min(NOTIFICATION_DIGEST_WINDOW_MS_MIN)
  .max(NOTIFICATION_DIGEST_WINDOW_MS_MAX);

/** Durée de la fenêtre après `escalation` fermetures non vides d'affilée. */
export function notificationDigestWindowMs(baseMs: number, escalation: number): number {
  const steps = Math.max(0, Math.min(escalation, NOTIFICATION_DIGEST_MAX_ESCALATION));
  return Math.min(baseMs * 2 ** steps, NOTIFICATION_DIGEST_WINDOW_MS_MAX);
}

/**
 * Clé de regroupement.
 *
 * C'est **l'événement**, et rien de plus fin. Grouper par application ou par
 * cible rendrait chaque ligne plus précise mais ramènerait le problème : une
 * panne d'infrastructure qui casse cinquante applications produirait cinquante
 * groupes, donc cinquante messages. La finesse appartient au *contenu* du
 * résumé — chaque ligne nomme son application —, pas à la clé.
 *
 * Second bénéfice, structurel : les canaux s'abonnent **par événement**. Une
 * clé calquée sur l'événement garantit qu'un résumé part exactement aux canaux
 * qui auraient reçu les alertes unitaires qu'il remplace.
 */
export function notificationDigestGroupKey(event: string): string {
  return event;
}

// ─── le message de résumé ─────────────────────────────────────────────────────

/**
 * Une ligne de résumé. `label` est la raison d'être du type : c'est ce qui
 * empêche le résumé d'être un compteur. Il nomme l'objet concerné — un
 * déploiement, un compte —, pas la catégorie, qui est déjà dans le titre.
 */
export const notificationDigestItemSchema = z.object({
  occurredAt: z.string().datetime(),
  label: z.string().trim().min(1).max(200),
  /** Une précision courte : l'étape en échec, le verdict du scan. */
  detail: z.string().trim().min(1).max(300).nullable().default(null),
  url: z.string().url().max(500).nullable().default(null),
});

export type NotificationDigestItem = z.infer<typeof notificationDigestItemSchema>;

export const notificationDigestSchema = z.object({
  /** Discriminant : un canal ne doit jamais confondre un résumé et une alerte. */
  type: z.literal('digest'),
  event: z.string().min(1).max(80),
  severity: notificationSeveritySchema,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(2000),
  /** Ce que le résumé remplace, nommé. Au plus `NOTIFICATION_DIGEST_ITEM_LIMIT`. */
  items: z.array(notificationDigestItemSchema).min(1).max(NOTIFICATION_DIGEST_ITEM_LIMIT),
  /** Total retenu sur la fenêtre. Supérieur à `items.length` quand la borne a mordu. */
  count: z.number().int().min(1),
  windowStartedAt: z.string().datetime(),
  windowEndedAt: z.string().datetime(),
  /** Durée de la fenêtre qui se ferme, puis de celle qui s'ouvre. */
  windowMs: z.number().int().positive(),
  nextWindowMs: z.number().int().positive(),
  url: z.string().url().max(500).nullable().default(null),
  instance: z.string().trim().min(1).max(60),
  occurredAt: z.string().datetime(),
  /** Langue de composition. Même motif que sur `notificationMessageSchema`. */
  language: z.enum(UI_LANGUAGES).default(DEFAULT_UI_LANGUAGE),
});

export type NotificationDigest = z.infer<typeof notificationDigestSchema>;

/** Lignes tues faute de place dans le stockage borné. */
export function notificationDigestOmitted(digest: NotificationDigest): number {
  return Math.max(0, digest.count - digest.items.length);
}

// ─── mise en forme commune ────────────────────────────────────────────────────

/**
 * « 15 s », « 5 min », « 1 h 20 ». Une durée lisible, pas un ISO 8601.
 *
 * Sans dictionnaire, et ce n'est pas un oubli : `s`, `min` et `h` sont les
 * mêmes symboles dans les deux langues. Y faire passer une traduction
 * ajouterait une langue à porter pour rendre exactement la même chaîne.
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

/** `10:02:11` — l'heure seule, en UTC, telle que l'ISO la porte déjà. */
export function digestTimeOfDay(iso: string): string {
  return iso.length >= 19 ? iso.slice(11, 19) : iso;
}

/**
 * Une ligne de résumé en texte brut. Elle vit ici et non dans chaque canal :
 * c'est le rendu du *type neutre*, sans protocole, et trois copies finiraient
 * par diverger.
 */
export function renderDigestItemLine(item: NotificationDigestItem): string {
  return `${digestTimeOfDay(item.occurredAt)} — ${item.label}${item.detail ? ` — ${item.detail}` : ''}`;
}

/**
 * La phrase que **tout** canal doit rendre quand il tronque la liste. Sans
 * elle, dix lignes affichées sur cinquante retenues sont un mensonge par
 * omission.
 */
export function renderDigestOmission(
  omitted: number,
  language: UiLanguage = DEFAULT_UI_LANGUAGE,
): string | null {
  if (omitted <= 0) return null;
  return t(language, 'omission', { count: omitted });
}

/**
 * Rendu texte complet, commun aux canaux qui en ont besoin (la partie
 * `text/plain` d'un e-mail, le repli d'un canal sans balisage).
 *
 * `maxItems` borne la liste — un canal court passe 5, un e-mail ne passe rien.
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
  /** Libellé de l'événement au catalogue, ex. « Déploiement en échec ». */
  eventLabel: string;
  items: NotificationDigestItem[];
  /** Total retenu, borne de stockage comprise. */
  count: number;
  windowStartedAt: string;
  windowEndedAt: string;
  windowMs: number;
  nextWindowMs: number;
  instance: string;
  /** Racine du panel, sans barre finale. `null` si inconnue. */
  panelUrl: string | null;
  /** Chemin du panel qui montre ces objets, ex. `/deployments`. */
  path: string | null;
  /**
   * Langue de l'instance. Résolue par le worker, qui a lu les paramètres — le
   * `eventLabel` ci-dessus doit venir de la même langue.
   */
  language: UiLanguage;
};

/**
 * Compose le résumé neutre. Aucun protocole n'est connu ici — même règle que
 * `buildNotificationMessage()`.
 *
 * Le corps **explique l'arbitrage** plutôt que de le subir : il dit que la
 * première alerte est partie seule, combien d'événements ont été retenus, sur
 * quelle fenêtre, et quand arrivera le prochain résumé. Un opérateur qui reçoit
 * un résumé doit comprendre pourquoi il en reçoit un plutôt que dix.
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
