import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { imageUpdateStatusEnum } from '../enums.js';
import { deployments } from './deployments.js';
import { applications, targets } from './infra.js';

/**
 * The last finding about each deployed service's image: what runs, what the
 * registry announces today for the same tag, and whether a more recent tag
 * exists.
 *
 * One row per (application, target, service): an application deployed on two
 * machines can run there on two different contents — one was redeployed
 * yesterday, the other six months ago. The row is **replaced** at each check;
 * the history of announcements is in the audit log (`image.update.available`),
 * which is also what notifies.
 *
 * The values are digests (`sha256:…`) and public tags: nothing sensitive,
 * nothing to encrypt.
 */
export const imageUpdates = pgTable(
  'image_updates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    /** The deployment in service at the time of the finding. */
    deploymentId: uuid('deployment_id').references(() => deployments.id, {
      onDelete: 'set null',
    }),
    service: text('service').notNull(),
    /** The reference as written in the AppSpec: `postgres:16`. */
    image: text('image').notNull(),
    status: imageUpdateStatusEnum('status').notNull(),
    /** What runs. Several during a rollout; the first is enough for display. */
    runningDigest: text('running_digest'),
    /** What the registry announces today for this tag. */
    latestDigest: text('latest_digest'),
    /** The most recent tag of the same major series, if it exceeds the deployed tag. */
    newerTag: text('newer_tag'),
    /** The most recent of the following majors — a migration, not a fix. */
    nextMajorTag: text('next_major_tag'),
    /** Why the finding is `unknown`: private image, unreachable registry… */
    error: text('error'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * What was already announced (`updateNoticeKey()`): the same finding only
     * notifies once, however often one checks.
     */
    notifiedKey: text('notified_key'),
  },
  (t) => [
    uniqueIndex('image_updates_app_target_service_idx').on(t.applicationId, t.targetId, t.service),
    index('image_updates_application_idx').on(t.applicationId),
    index('image_updates_status_idx').on(t.status),
  ],
);

export type ImageUpdateRow = typeof imageUpdates.$inferSelect;
