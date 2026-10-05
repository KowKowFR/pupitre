import type { ChannelConfig, NotificationEventKey } from '@pupitre/core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { notificationChannelKindEnum } from '../enums.js';
import { users } from './auth.js';

/**
 * A way of warning someone, configured by an operator.
 *
 * ── Why a table and not the instance settings' JSONB ────────────────────────
 * `app_settings.value` is an excellent place for a setting: it accepts one more
 * without a migration. It is, however, the wrong place for this, for three
 * reasons all tied to the object's nature:
 *
 *   1. There are **several**, created and deleted on demand. An array in a JSONB
 *      has neither stable identity, nor name uniqueness, nor a foreign key to the
 *      author: three guarantees we would rewrite in TypeScript, that is that we
 *      would not have.
 *   2. They carry **secrets**. The project file is formal: a secret never goes
 *      into the settings' JSONB — the AI API key already follows that rule with
 *      its dedicated encrypted column. Separating secrets and configuration
 *      would therefore have meant spreading them between two places paired by
 *      hand.
 *   3. They carry a **run state** that changes by itself: last success, last
 *      failure, consecutive failures. Writing that state at each send would
 *      rewrite the instance settings' whole JSONB — hence compete with the
 *      settings screen, for data that is not a setting.
 */
export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: notificationChannelKindEnum('kind').notNull(),
    /** What the operator calls it: "on-call", "#ops channel". Unique. */
    name: text('name').notNull().unique(),
    /**
     * A disabled channel is kept with its configuration. Turning off a noisy
     * integration must not force entering a token again to turn it back on.
     */
    enabled: boolean('enabled').notNull().default(true),
    /** The channel's **non-secret** fields, as the catalog describes them. */
    config: jsonb('config').$type<ChannelConfig>().notNull().default({}),
    /**
     * The secret fields, serialized as JSON then encrypted as a single block.
     * AES-256-GCM under `MASTER_KEY`, `version:iv:authTag:ciphertext` format — the
     * same pattern as `targets.encrypted_credential` and
     * `app_settings.ai_api_key_encrypted`.
     *
     * A dedicated column and not a `config` field: it is what allows serializing
     * `config` into an API response or an audit entry without risk, precisely
     * because the secret is not there.
     */
    encryptedSecrets: text('encrypted_secrets'),
    /**
     * The events this channel subscribes to. A JSONB array rather than a link table:
     * the list is short, always read whole, and never queried the other way.
     */
    events: jsonb('events').$type<NotificationEventKey[]>().notNull().default([]),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    /** Message of the last failure, **already scrubbed** of anything that looks like a secret. */
    lastError: text('last_error'),
    /**
     * Failures in a row. Reset by the first success. It is what tells "the server
     * hiccupped" from "this channel has not worked for three weeks", and the screen
     * says it.
     */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** `text` and not `uuid`: `users.id` is a Better Auth identifier. */
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('notification_channels_enabled_idx').on(t.enabled)],
);

/**
 * The grouping setting — one row, two useful columns.
 *
 * ── Why not `app_settings` ──────────────────────────────────────────────────
 * It would be the natural place: one more scalar in the JSONB, without a
 * migration. Two reasons not to go there. First, `app_settings.value` is
 * rewritten whole at each save of the settings screen, and this value is read
 * **at each notifiable event** — it is data of the notifications' hot path, not
 * an instance preset. Second, the settings schema is another work's single
 * source of truth; adding a field to it for a reason foreign to it makes it grow
 * by accident. The channels table had been taken out of the JSONB for similar
 * reasons, and the reasoning holds here too.
 *
 * ── Why the setting exists ──────────────────────────────────────────────────
 * Five minutes suit an instance that deploys ten times a day; they are too long
 * for an on-call that wants to see the wave live, too short for a noisy fleet.
 * The setting is **bounded**: `NOTIFICATION_DIGEST_WINDOW_MS_MIN` forbids
 * bringing it to zero. A volume guard that can be disabled is a disabled guard.
 */
export const notificationPolicy = pgTable(
  'notification_policy',
  {
    /** Single row. The constraint is carried by the database, not by a convention. */
    id: integer('id').primaryKey().default(1),
    /** Base window, in milliseconds. It doubles at each lasting storm. */
    windowMs: integer('window_ms').notNull().default(300_000),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [check('notification_policy_single_row', sql`${t.id} = 1`)],
);

/**
 * An event's grouping state — the volume guard's memory.
 *
 * ── Why in the database and not in the worker's memory ──────────────────────
 * Because a worker restart in the middle of a storm would release everything at
 * once: the open window would disappear, each following event would go out
 * "immediately" again, and grouping would have produced exactly the behavior it
 * was meant to prevent — worse, since it would also have lost the events
 * already held. The state therefore lives where it survives everything: the
 * current window here, the held events in the sister table.
 *
 * ── Why not Redis ───────────────────────────────────────────────────────────
 * Redis already carries the jobs' deduplication, and it is the right place for
 * information whose loss is benign (at worst, a duplicate message). Here the
 * loss is not benign: it loses held alerts. A table, a transaction, a primary
 * key — and the atomicity of the "immediate or held" decision is Postgres's, not
 * an application lock's.
 */
export const notificationDigestGroups = pgTable('notification_digest_groups', {
  /**
   * The grouping key, today the event itself (`notificationDigestGroupKey()`).
   * `text` and not the events enumeration: the key's granularity is a decision of
   * `@pupitre/core`, and refining it one day must not cost a migration.
   */
  groupKey: text('group_key').primaryKey(),
  event: text('event').notNull(),
  /**
   * End of the open window. **`null` is the quiet state**: no ongoing storm, the
   * next alert goes out without delay. It is the column that carries the whole
   * trade-off — empty, we warn fast; full, we warn little.
   */
  windowEndsAt: timestamp('window_ends_at', { withTimezone: true }),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }),
  /** Duration of the current window. It doubles at each non-empty closing. */
  windowMs: integer('window_ms').notNull().default(300_000),
  /** Non-empty closings in a row, bounded. It is the self-adjusted "rate threshold". */
  escalation: integer('escalation').notNull().default(0),
  /**
   * Events held since opening. Counts **beyond** the number of lines kept: it is
   * what lets the digest say "500 alerts, 100 named", rather than lie by
   * omission.
   */
  heldCount: integer('held_count').notNull().default(0),
  firstHeldAt: timestamp('first_held_at', { withTimezone: true }),
  lastHeldAt: timestamp('last_held_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A held event, already reduced to the line it will take in the digest.
 *
 * We do **not** copy the audit payload: it is bulky, its shape is guaranteed by
 * nothing, and the line is perfectly computable when the event arrives — the
 * actor is resolved, the context is fresh. What is stored is therefore exactly
 * what will be read, no more, no less.
 */
export const notificationDigestItems = pgTable(
  'notification_digest_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupKey: text('group_key')
      .notNull()
      .references(() => notificationDigestGroups.groupKey, { onDelete: 'cascade' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** What the line names: "deployment 4f2a…", "account alice@…". */
    label: text('label').notNull(),
    detail: text('detail'),
    url: text('url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notification_digest_items_group_idx').on(t.groupKey, t.occurredAt)],
);
