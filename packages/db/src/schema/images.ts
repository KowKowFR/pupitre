import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { imageUpdateStatusEnum } from '../enums.js';
import { deployments } from './deployments.js';
import { applications, targets } from './infra.js';

/**
 * Le dernier constat sur l'image de chaque service déployé : ce qui tourne,
 * ce que le registre annonce aujourd'hui pour le même tag, et s'il existe un
 * tag plus récent.
 *
 * Une ligne par (application, cible, service) : une application déployée sur
 * deux machines peut y tourner sur deux contenus différents — l'une a été
 * redéployée hier, l'autre il y a six mois. La ligne est **remplacée** à
 * chaque vérification ; l'historique des annonces, lui, est dans le journal
 * d'audit (`image.update.available`), qui est aussi ce qui notifie.
 *
 * Les valeurs sont des digests (`sha256:…`) et des tags publics : rien de
 * sensible, rien à chiffrer.
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
    /** Le déploiement en service au moment du constat. */
    deploymentId: uuid('deployment_id').references(() => deployments.id, {
      onDelete: 'set null',
    }),
    service: text('service').notNull(),
    /** La référence telle qu'écrite dans l'AppSpec : `postgres:16`. */
    image: text('image').notNull(),
    status: imageUpdateStatusEnum('status').notNull(),
    /** Ce qui tourne. Plusieurs pendant un rollout ; le premier suffit à l'affichage. */
    runningDigest: text('running_digest'),
    /** Ce que le registre annonce aujourd'hui pour ce tag. */
    latestDigest: text('latest_digest'),
    /** Le tag le plus récent de la même série majeure, s'il dépasse le tag déployé. */
    newerTag: text('newer_tag'),
    /** La plus récente des majeures suivantes — une migration, pas un correctif. */
    nextMajorTag: text('next_major_tag'),
    /** Pourquoi le constat est `unknown` : image privée, registre injoignable… */
    error: text('error'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Ce qui a déjà été annoncé (`updateNoticeKey()`) : un même constat ne
     * notifie qu'une fois, si souvent qu'on vérifie.
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
