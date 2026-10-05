import {
  NOTIFICATION_DIGEST_ITEM_LIMIT,
  NOTIFICATION_DIGEST_MAX_ESCALATION,
  NOTIFICATION_DIGEST_WINDOW_MS_DEFAULT,
  notificationDigestWindowMs,
  notificationDigestWindowMsSchema,
  type NotificationDigestItem,
} from '@pupitre/core';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import {
  notificationDigestGroups,
  notificationDigestItems,
  notificationPolicy,
} from './schema/notifications.js';

/**
 * The notifications' grouping state — the durable part of the volume guard.
 *
 * ── The invariant this module holds ─────────────────────────────────────────
 * For a given group, at any time, **only one** of the two statements is true:
 *   — the window is closed (`window_ends_at is null`): the next alert goes out
 *     without delay, and nothing is waiting;
 *   — the window is open: no alert of this group goes out, everything is held
 *     and named, and closing will produce exactly one digest.
 *
 * Going from one to the other is a decision, and a decision made by two
 * processes at once is a wrong decision: two "first" alerts would go out at the
 * same time, or two digests of the same storm. Hence each flip fits in **one
 * transaction with `select … for update`** on the group's row. The exclusion is
 * Postgres's — not an application lock, not an optimistic `if`. It is the same
 * rule as port collision avoidance, which is a uniqueness constraint and not a
 * test in TypeScript.
 *
 * ── What "surviving a restart" means here ───────────────────────────────────
 * Everything that decides lives in these two tables. The worker has no grouping
 * state in memory: it restarts, reads back, and finds exactly the window it had
 * left, with the events already held. A restart in the middle of a storm
 * therefore releases nothing — that was the risk, and it is why Redis did not
 * fit.
 */

// ─── the setting ──────────────────────────────────────────────────────────────

export type NotificationDigestPolicy = {
  /** Base window, in milliseconds. */
  windowMs: number;
  updatedAt: Date | null;
  updatedBy: string | null;
};

/**
 * The setting, or its default.
 *
 * No row in the database = new instance: we return the default rather than
 * impose an insert at install time. The same pattern as the instance settings,
 * which return a complete object on an empty database.
 */
export async function getNotificationDigestPolicy(
  db: Database = getDb(),
): Promise<NotificationDigestPolicy> {
  const [row] = await db.select().from(notificationPolicy).where(eq(notificationPolicy.id, 1));
  return {
    windowMs: row?.windowMs ?? NOTIFICATION_DIGEST_WINDOW_MS_DEFAULT,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

/**
 * Changes the base window. The value is **bounded by Zod**, on the
 * `@pupitre/core` side: grouping can be shortened, never removed.
 *
 * Windows already open keep their duration until they close — shortening them
 * by authority would make a digest go out earlier than promised by the previous
 * message, which announced a delay.
 */
export async function setNotificationDigestPolicy(
  windowMs: number,
  actorId: string | null,
  db: Database = getDb(),
): Promise<NotificationDigestPolicy> {
  const value = notificationDigestWindowMsSchema.parse(windowMs);
  const now = new Date();

  await db
    .insert(notificationPolicy)
    .values({ id: 1, windowMs: value, updatedAt: now, updatedBy: actorId })
    .onConflictDoUpdate({
      target: notificationPolicy.id,
      set: { windowMs: value, updatedAt: now, updatedBy: actorId },
    });

  return { windowMs: value, updatedAt: now, updatedBy: actorId };
}

// ─── admission: immediate, or held ────────────────────────────────────────────

export type NotificationAdmissionInput = {
  groupKey: string;
  event: string;
  /** The line this event will take in a digest, already composed. */
  item: NotificationDigestItem;
  /** Injectable for checks; `new Date()` in operation. */
  now?: Date;
};

export type NotificationAdmission = {
  /** `immediate`: the window was closed, the message goes out. `held`: it is held. */
  mode: 'immediate' | 'held';
  windowEndsAt: Date;
  windowMs: number;
  /** Events held in the current window, this one included. */
  heldCount: number;
};

/**
 * Decides the fate of a notifiable event, and records that decision.
 *
 * Three cases, in this order:
 *
 *   1. **window closed** → `immediate`. The message goes out without delay and
 *      the window opens. It is the isolated outage's case, and it is *tested
 *      first*: nothing, ever, delays an incident's first alert.
 *   2. **window open** → `held`. The event is stored, named.
 *   3. **window due but held events waiting** → `held` too. Letting this one go
 *      out immediately while forty others wait for the sweep would produce a
 *      single message in the middle of a storm: the digest's consistency comes
 *      before a handful of seconds.
 *
 * Storing lines is capped at `NOTIFICATION_DIGEST_ITEM_LIMIT`; beyond that the
 * counter goes on alone. The digest will say how many lines it leaves out — a
 * counter that overflows silently would be exactly the flaw being fixed.
 */
export async function admitNotification(
  input: NotificationAdmissionInput,
  db: Database = getDb(),
): Promise<NotificationAdmission> {
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const policy = await getNotificationDigestPolicy(tx);

    // Materializes the group's row before locking it: on a group still unknown, a
    // `for update` locks nothing and two concurrent first alerts would both go out.
    await tx
      .insert(notificationDigestGroups)
      .values({ groupKey: input.groupKey, event: input.event, windowMs: policy.windowMs })
      .onConflictDoNothing();

    const [group] = await tx
      .select()
      .from(notificationDigestGroups)
      .where(eq(notificationDigestGroups.groupKey, input.groupKey))
      .for('update');

    if (!group) {
      // Should not happen: the insert comes first. We do not block an alert on a
      // bookkeeping anomaly.
      return {
        mode: 'immediate' as const,
        windowEndsAt: new Date(now.getTime() + policy.windowMs),
        windowMs: policy.windowMs,
        heldCount: 0,
      };
    }

    const open = group.windowEndsAt !== null && group.windowEndsAt > now;
    /**
     * A due window whose content the sweep has not taken yet. Letting this one go
     * out immediately while forty others wait would produce a single message in the
     * middle of a storm.
     *
     * A due and **empty** window counts as a closed window: the alert must not wait
     * for the sweep to formally close it.
     */
    const awaitingSweep = group.windowEndsAt !== null && group.heldCount > 0;

    if (!open && !awaitingSweep) {
      await tx
        .update(notificationDigestGroups)
        .set({
          event: input.event,
          windowStartedAt: now,
          windowEndsAt: new Date(now.getTime() + policy.windowMs),
          windowMs: policy.windowMs,
          escalation: 0,
          heldCount: 0,
          firstHeldAt: null,
          lastHeldAt: null,
          updatedAt: now,
        })
        .where(eq(notificationDigestGroups.groupKey, input.groupKey));

      // Defensive purge: a window being reopened must not inherit lines from a
      // previous storm badly closed.
      await tx
        .delete(notificationDigestItems)
        .where(eq(notificationDigestItems.groupKey, input.groupKey));

      return {
        mode: 'immediate' as const,
        windowEndsAt: new Date(now.getTime() + policy.windowMs),
        windowMs: policy.windowMs,
        heldCount: 0,
      };
    }

    if (group.heldCount < NOTIFICATION_DIGEST_ITEM_LIMIT) {
      await tx.insert(notificationDigestItems).values({
        groupKey: input.groupKey,
        occurredAt: new Date(input.item.occurredAt),
        label: input.item.label,
        detail: input.item.detail,
        url: input.item.url,
      });
    }

    await tx
      .update(notificationDigestGroups)
      .set({
        heldCount: sql`${notificationDigestGroups.heldCount} + 1`,
        firstHeldAt: sql`coalesce(${notificationDigestGroups.firstHeldAt}, ${now})`,
        lastHeldAt: now,
        updatedAt: now,
      })
      .where(eq(notificationDigestGroups.groupKey, input.groupKey));

    return {
      mode: 'held' as const,
      windowEndsAt: group.windowEndsAt ?? now,
      windowMs: group.windowMs,
      heldCount: group.heldCount + 1,
    };
  });
}

// ─── closing: the digest, or silence ──────────────────────────────────────────

export type NotificationDigestClaim = {
  event: string;
  items: NotificationDigestItem[];
  /** Total held — greater than `items.length` when the storage cap bit. */
  count: number;
  windowStartedAt: Date;
  windowEndedAt: Date;
  windowMs: number;
  nextWindowMs: number;
};

/** Groups whose window is due. An indexed query, called by the sweep. */
export async function dueNotificationDigestGroups(
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ groupKey: notificationDigestGroups.groupKey })
    .from(notificationDigestGroups)
    .where(
      and(
        isNotNull(notificationDigestGroups.windowEndsAt),
        lte(notificationDigestGroups.windowEndsAt, now),
      ),
    );
  return rows.map((row) => row.groupKey);
}

/**
 * Closes a due window and **claims** its content.
 *
 * Returns `null` when there is nothing to say — either the window is not due,
 * or it closed empty. The second case is the heart of the trade-off: an empty
 * window puts the group back to silence, so the next isolated outage will go
 * out **immediately**. Without that, a single incident would cost a window's
 * latency indefinitely.
 *
 * When there is material, the same transaction does three inseparable things:
 * it takes the lines, it erases them, and it reopens a longer window.
 * Separating them would leave a window where a second sweep would send the same
 * digest again.
 */
export async function claimNotificationDigest(
  groupKey: string,
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<NotificationDigestClaim | null> {
  return db.transaction(async (tx) => {
    const [group] = await tx
      .select()
      .from(notificationDigestGroups)
      .where(eq(notificationDigestGroups.groupKey, groupKey))
      .for('update');

    if (!group || group.windowEndsAt === null || group.windowEndsAt > now) return null;

    const policy = await getNotificationDigestPolicy(tx);

    const rows = await tx
      .select()
      .from(notificationDigestItems)
      .where(eq(notificationDigestItems.groupKey, groupKey))
      .orderBy(asc(notificationDigestItems.occurredAt))
      .limit(NOTIFICATION_DIGEST_ITEM_LIMIT);

    if (group.heldCount === 0 || rows.length === 0) {
      await tx
        .update(notificationDigestGroups)
        .set({
          windowEndsAt: null,
          windowStartedAt: null,
          windowMs: policy.windowMs,
          escalation: 0,
          heldCount: 0,
          firstHeldAt: null,
          lastHeldAt: null,
          updatedAt: now,
        })
        .where(eq(notificationDigestGroups.groupKey, groupKey));
      await tx
        .delete(notificationDigestItems)
        .where(eq(notificationDigestItems.groupKey, groupKey));
      return null;
    }

    const escalation = Math.min(group.escalation + 1, NOTIFICATION_DIGEST_MAX_ESCALATION);
    const nextWindowMs = notificationDigestWindowMs(policy.windowMs, escalation);

    await tx.delete(notificationDigestItems).where(eq(notificationDigestItems.groupKey, groupKey));

    await tx
      .update(notificationDigestGroups)
      .set({
        windowStartedAt: now,
        windowEndsAt: new Date(now.getTime() + nextWindowMs),
        windowMs: nextWindowMs,
        escalation,
        heldCount: 0,
        firstHeldAt: null,
        lastHeldAt: null,
        updatedAt: now,
      })
      .where(eq(notificationDigestGroups.groupKey, groupKey));

    return {
      event: group.event,
      items: rows.map((row) => ({
        occurredAt: row.occurredAt.toISOString(),
        label: row.label,
        detail: row.detail,
        url: row.url,
      })),
      count: group.heldCount,
      windowStartedAt: group.windowStartedAt ?? group.firstHeldAt ?? rows[0]!.occurredAt,
      windowEndedAt: now,
      windowMs: group.windowMs,
      nextWindowMs,
    };
  });
}

// ─── reading for the screen ───────────────────────────────────────────────────

export type NotificationDigestState = {
  groupKey: string;
  event: string;
  /** `null` = quiet group: the next alert will go out without delay. */
  windowEndsAt: Date | null;
  windowMs: number;
  escalation: number;
  heldCount: number;
  firstHeldAt: Date | null;
  lastHeldAt: Date | null;
};

/**
 * What the grouping is doing, at this instant.
 *
 * The notifications screen shows it: an operator who receives no message must
 * be able to tell "nothing happened" from "forty alerts are held and the digest
 * goes out in two minutes". Without this read, the guard would be
 * indistinguishable from an outage.
 */
export async function listNotificationDigestStates(
  db: Database = getDb(),
): Promise<NotificationDigestState[]> {
  const rows = await db
    .select()
    .from(notificationDigestGroups)
    .orderBy(asc(notificationDigestGroups.groupKey));

  return rows.map((row) => ({
    groupKey: row.groupKey,
    event: row.event,
    windowEndsAt: row.windowEndsAt,
    windowMs: row.windowMs,
    escalation: row.escalation,
    heldCount: row.heldCount,
    firstHeldAt: row.firstHeldAt,
    lastHeldAt: row.lastHeldAt,
  }));
}
