import { z } from 'zod';
import { imageMediaTypeSchema } from './media.js';

/**
 * The panel's real time: who is there, what is being said, what just changed.
 *
 * A single Redis pub/sub channel carries everything — the same mechanics as the
 * deployment logs (`deploy:{id}`), relayed over SSE by the panel. Each message
 * is a typed and validated event: the panel never relays a string it could not
 * read.
 *
 * This module is pure: no Redis here, only the names, the shapes and the rules.
 * The panel and the worker publish with their own connections.
 */

export const REALTIME_CHANNEL = 'pupitre:realtime';

// ─── Presence ────────────────────────────────────────────────────────────────

/**
 * Green, orange, red, grey. `busy` is never derived: it is the person's choice
 * ("Do not disturb"). `away` is when the tab is hidden or the keyboard and mouse
 * have not been touched for a while.
 */
export const PRESENCE_STATUSES = ['online', 'away', 'busy', 'offline'] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

/** What the person chooses in their menu. `null`: let it be. */
export const PRESENCE_CHOICES = ['away', 'busy'] as const;
export type PresenceChoice = (typeof PRESENCE_CHOICES)[number];

/** The open stream refreshes presence at this rate. */
export const PRESENCE_TOUCH_MS = 25_000;
/** Without news for this long, the person is offline — tab killed, network cut. */
export const PRESENCE_STALE_MS = 75_000;
/** Without keyboard, mouse or foreground tab for this long: away. */
export const PRESENCE_IDLE_MS = 5 * 60_000;
/** A tab reports an interaction at most once per period. */
export const PRESENCE_INPUT_THROTTLE_MS = 60_000;

export type PresenceInput = {
  /** Open tabs, all processes together. */
  connections: number;
  /** Last sign of life of an open stream. */
  lastSeen: number | null;
  /**
   * Last interaction, all tabs together. Inactivity is derived from the time
   * elapsed rather than declared by each tab: two tabs, one forgotten in the
   * background, the other under the fingers, never contradict each other — it is
   * the last interaction that counts.
   */
  lastInput: number | null;
  choice: PresenceChoice | null;
};

/**
 * The displayed state, derived — never stored as is, so that it cannot
 * contradict its causes. The choice wins over activity; the absence of a
 * connection wins over everything.
 */
export function effectivePresence(input: PresenceInput, now: number): PresenceStatus {
  if (input.connections <= 0 || input.lastSeen === null) return 'offline';
  if (now - input.lastSeen > PRESENCE_STALE_MS) return 'offline';
  if (input.choice === 'busy') return 'busy';
  if (input.choice === 'away') return 'away';
  if (input.lastInput === null || now - input.lastInput > PRESENCE_IDLE_MS) return 'away';
  return 'online';
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

/**
 * What moved, coarse-grained. A screen listens to the topics that concern it and
 * reads itself again — it does not receive the data itself, which would
 * otherwise bypass the page's permissions.
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
  // Scheduled tasks first: `target:preflight:all` is one of them.
  [/^(scan|health):periodic$|^cleanup:|^target:preflight:all$/, 'jobs'],
  [/^target:(preflight|metrics|metrics_sweep)$/, 'targets'],
  [/^workload:(remove|update|control)$/, 'targets'],
  [/^images:check$/, 'applications'],
  [/^source:archive-inspect$/, 'applications'],
  [/^backup:(application|restore|delete)$/, 'applications'],
  [/^backup:panel$/, 'settings'],
  // A proxy connection is read on the target; a domain, on the application.
  [/^proxy:(install|check|remove|link-check)$/, 'targets'],
  [/^proxy:apply$|^routes:check$/, 'applications'],
  [/^monitor:/, 'monitors'],
];

/**
 * A BullMQ task's topic, or `null` for those whose outcome changes nothing on
 * screen (reading logs, listing containers, ping).
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
  // A forecast is about a machine, a probe, a domain or an application: it is
  // read on the overview and in the targets' record.
  forecast: 'targets',
  // A maintenance window is read on the overview and in the records of targets
  // and probes.
  maintenance_window: 'targets',
  // An accepted vulnerability is read in the application's record.
  vulnerability_acceptance: 'applications',
  // A status page is composed in the administration.
  status_page: 'settings',
  // An announcement comments on a probe outage or a maintenance window.
  status_update: 'monitors',
};

/** The topic of an audit log line. */
export function liveTopicOfResource(resourceType: string): LiveTopic | null {
  return RESOURCE_TOPICS[resourceType] ?? null;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export const chatMentionSchema = z.object({
  kind: z.enum(['user', 'target', 'app']),
  id: z.string().min(1).max(64),
  /** The name at the time of the message: readable even if the object disappears later. */
  label: z.string().max(120),
});
export type ChatMention = z.infer<typeof chatMentionSchema>;

/** What a reply shows of the original: enough to recognize it, no more. */
export const chatQuoteSchema = z.object({
  id: z.string().uuid(),
  authorId: z.string().nullable(),
  authorName: z.string().nullable(),
  /** The start of the text, mention tokens replaced by their label. */
  excerpt: z.string().max(200),
  deleted: z.boolean(),
});
export type ChatQuote = z.infer<typeof chatQuoteSchema>;

/** An emoji and who set it. The order is the first reaction's. */
export const chatReactionSchema = z.object({
  emoji: z.string().min(1).max(32),
  userIds: z.array(z.string()),
});
export type ChatReaction = z.infer<typeof chatReactionSchema>;

/**
 * An image attached to a message: its metadata only. The bytes are served
 * separately (`/api/chat/attachments/:id`) — the real-time channel only ever
 * carries enough to reserve the space on screen.
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
  /** The complete state of a message's reactions: replaying twice changes nothing. */
  z.object({
    type: z.literal('chat.reactions'),
    messageId: z.string().uuid(),
    channel: z.string(),
    reactions: z.array(chatReactionSchema),
  }),
  z.object({
    type: z.literal('live'),
    topic: z.enum(LIVE_TOPICS),
    /** Where the signal comes from: a worker task, or an audit log line. */
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
