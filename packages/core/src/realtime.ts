import { z } from 'zod';
import { imageMediaTypeSchema } from './media.js';

/**
 * Le temps réel du panel : qui est là, ce qui se dit, ce qui vient de changer.
 *
 * Un seul canal Redis pub/sub porte tout — la même mécanique que les logs de
 * déploiement (`deploy:{id}`), relayée en SSE par le panel. Chaque message est
 * un événement typé et validé : le panel ne relaie jamais une chaîne qu'il n'a
 * pas su lire.
 *
 * Ce module est pur : pas de Redis ici, seulement les noms, les formes et les
 * règles. Le panel et le worker publient avec leurs propres connexions.
 */

export const REALTIME_CHANNEL = 'pupitre:realtime';

// ─── Présence ────────────────────────────────────────────────────────────────

/**
 * Vert, orange, rouge, gris. `busy` n'est jamais déduit : c'est un choix de la
 * personne (« Ne pas déranger »). `away` l'est quand l'onglet est caché ou
 * qu'on n'a pas touché au clavier ni à la souris depuis un moment.
 */
export const PRESENCE_STATUSES = ['online', 'away', 'busy', 'offline'] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

/** Ce que la personne choisit dans son menu. `null` : laisser faire. */
export const PRESENCE_CHOICES = ['away', 'busy'] as const;
export type PresenceChoice = (typeof PRESENCE_CHOICES)[number];

/** Le flux ouvert rafraîchit la présence à ce rythme. */
export const PRESENCE_TOUCH_MS = 25_000;
/** Sans nouvelle depuis ce délai, la personne est hors ligne — onglet tué, réseau coupé. */
export const PRESENCE_STALE_MS = 75_000;
/** Sans clavier, souris ni onglet au premier plan depuis ce délai : absent. */
export const PRESENCE_IDLE_MS = 5 * 60_000;
/** Un onglet signale une interaction au plus une fois par période. */
export const PRESENCE_INPUT_THROTTLE_MS = 60_000;

export type PresenceInput = {
  /** Onglets ouverts, tous processus confondus. */
  connections: number;
  /** Dernier signe de vie d'un flux ouvert. */
  lastSeen: number | null;
  /**
   * Dernière interaction, tous onglets confondus. L'inactivité se déduit du
   * temps écoulé plutôt que d'être déclarée par chaque onglet : deux onglets,
   * l'un oublié en arrière-plan, l'autre sous les doigts, ne se contredisent
   * jamais — c'est la dernière interaction qui compte.
   */
  lastInput: number | null;
  choice: PresenceChoice | null;
};

/**
 * L'état affiché, déduit — jamais stocké tel quel, pour qu'il ne puisse pas
 * contredire ses causes. Le choix l'emporte sur l'activité ; l'absence de
 * connexion l'emporte sur tout.
 */
export function effectivePresence(input: PresenceInput, now: number): PresenceStatus {
  if (input.connections <= 0 || input.lastSeen === null) return 'offline';
  if (now - input.lastSeen > PRESENCE_STALE_MS) return 'offline';
  if (input.choice === 'busy') return 'busy';
  if (input.choice === 'away') return 'away';
  if (input.lastInput === null || now - input.lastInput > PRESENCE_IDLE_MS) return 'away';
  return 'online';
}

// ─── Tableau de bord ─────────────────────────────────────────────────────────

/**
 * Ce qui a bougé, au gros grain. Un écran écoute les sujets qui le
 * concernent et se relit — il ne reçoit pas les données elles-mêmes, qui
 * passeraient sinon à côté des permissions de la page.
 */
export const LIVE_TOPICS = [
  'deployments',
  'targets',
  'applications',
  'monitors',
  'jobs',
  'users',
  'settings',
] as const;
export type LiveTopic = (typeof LIVE_TOPICS)[number];

const JOB_TOPICS: Array<[RegExp, LiveTopic]> = [
  [/^deployment:/, 'deployments'],
  [/^source:deploy$/, 'deployments'],
  [/^application:/, 'applications'],
  [/^app:(restart|stop|start)$/, 'deployments'],
  // Les tâches planifiées d'abord : `target:preflight:all` en est une.
  [/^(scan|health):periodic$|^cleanup:|^target:preflight:all$/, 'jobs'],
  [/^target:(preflight|metrics|metrics_sweep)$/, 'targets'],
  [/^workload:(remove|update|control)$/, 'targets'],
  [/^images:check$/, 'applications'],
  [/^source:archive-inspect$/, 'applications'],
  [/^backup:(application|restore|delete)$/, 'applications'],
  [/^backup:panel$/, 'settings'],
  // Une connexion de proxy se lit sur la cible ; un domaine, sur l'application.
  [/^proxy:(install|check|remove|link-check)$/, 'targets'],
  [/^proxy:apply$|^routes:check$/, 'applications'],
  [/^monitor:/, 'monitors'],
];

/**
 * Le sujet d'une tâche BullMQ, ou `null` pour celles dont l'issue ne change
 * rien à l'écran (lecture de logs, liste de conteneurs, ping).
 */
export function liveTopicOfJob(jobName: string): LiveTopic | null {
  return JOB_TOPICS.find(([pattern]) => pattern.test(jobName))?.[1] ?? null;
}

const RESOURCE_TOPICS: Record<string, LiveTopic> = {
  deployment: 'deployments',
  application: 'applications',
  application_secret: 'applications',
  application_source: 'applications',
  source_archive: 'applications',
  target: 'targets',
  monitor: 'monitors',
  scheduled_job: 'jobs',
  job: 'jobs',
  user: 'users',
  role: 'users',
  api_token: 'users',
  settings: 'settings',
  source_connection: 'settings',
  notification_channel: 'settings',
  notification_policy: 'settings',
  // Une prévision porte sur une machine, une sonde, un domaine ou une
  // application : elle se lit sur la vue d'ensemble et dans la fiche des cibles.
  forecast: 'targets',
  // Une fenêtre de maintenance se lit sur la vue d'ensemble et dans les
  // fiches des cibles et des sondes.
  maintenance_window: 'targets',
  // Une page de statut se compose dans l'administration.
  status_page: 'settings',
  // Une annonce commente une panne de sonde ou une maintenance.
  status_update: 'monitors',
};

/** Le sujet d'une ligne du journal d'audit. */
export function liveTopicOfResource(resourceType: string): LiveTopic | null {
  return RESOURCE_TOPICS[resourceType] ?? null;
}

// ─── Événements ──────────────────────────────────────────────────────────────

export const chatMentionSchema = z.object({
  kind: z.enum(['user', 'target', 'app']),
  id: z.string().min(1).max(64),
  /** Le nom au moment du message : lisible même si l'objet disparaît ensuite. */
  label: z.string().max(120),
});
export type ChatMention = z.infer<typeof chatMentionSchema>;

/** Ce qu'une réponse montre de l'original : assez pour le reconnaître, pas plus. */
export const chatQuoteSchema = z.object({
  id: z.string().uuid(),
  authorId: z.string().nullable(),
  authorName: z.string().nullable(),
  /** Le début du texte, jetons de mention remplacés par leur libellé. */
  excerpt: z.string().max(200),
  deleted: z.boolean(),
});
export type ChatQuote = z.infer<typeof chatQuoteSchema>;

/** Un emoji et qui l'a posé. L'ordre est celui de la première réaction. */
export const chatReactionSchema = z.object({
  emoji: z.string().min(1).max(32),
  userIds: z.array(z.string()),
});
export type ChatReaction = z.infer<typeof chatReactionSchema>;

/**
 * Une image jointe à un message : ses métadonnées seulement. Les octets se
 * servent à part (`/api/chat/attachments/:id`) — le canal temps réel ne porte
 * jamais que de quoi réserver la place à l'écran.
 */
export const chatAttachmentSchema = z.object({
  id: z.string().uuid(),
  contentType: imageMediaTypeSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
});
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;

export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  channel: z.string().min(1).max(40),
  authorId: z.string().nullable(),
  authorName: z.string().nullable(),
  body: z.string(),
  mentions: z.array(chatMentionSchema),
  replyTo: chatQuoteSchema.nullable(),
  reactions: z.array(chatReactionSchema),
  attachments: z.array(chatAttachmentSchema).default([]),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const realtimeEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('presence'),
    userId: z.string(),
    status: z.enum(PRESENCE_STATUSES),
    at: z.number(),
  }),
  z.object({ type: z.literal('chat.message'), message: chatMessageSchema }),
  z.object({ type: z.literal('chat.deleted'), id: z.string().uuid(), channel: z.string() }),
  /** L'état complet des réactions d'un message : rejouer deux fois ne change rien. */
  z.object({
    type: z.literal('chat.reactions'),
    messageId: z.string().uuid(),
    channel: z.string(),
    reactions: z.array(chatReactionSchema),
  }),
  z.object({
    type: z.literal('live'),
    topic: z.enum(LIVE_TOPICS),
    /** D'où vient le signal : une tâche du worker, ou une ligne du journal. */
    source: z.enum(['job', 'audit']),
    detail: z.string().max(120),
  }),
  z.object({
    type: z.literal('activity'),
    id: z.string(),
    action: z.string(),
    resourceType: z.string(),
    resourceId: z.string().nullable(),
    actorId: z.string().nullable(),
    at: z.string(),
  }),
]);
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
export type RealtimeEventType = RealtimeEvent['type'];
