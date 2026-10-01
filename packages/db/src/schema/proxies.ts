import type { RouteCertificate } from '@pupitre/core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { proxyEnum, proxyPlacementEnum, proxyStatusEnum, routeStatusEnum } from '../enums.js';
import { users } from './auth.js';
import { applications, targets } from './infra.js';

/**
 * Les reverse proxies que le panel pilote.
 *
 * Un proxy « sur la cible » sert la machine où il tourne — un seul par
 * machine, tenu par un index unique partiel. `config` porte ce qui se montre
 * (mode, dossier, points d'entrée, résolveur, réglages ACME) ;
 * `encrypted_secrets`, ce qui ne se montre jamais — rien pour Traefik, des
 * identifiants d'API pour les proxies à venir —, chiffré sous `MASTER_KEY`.
 *
 * `managed` : Pupitre l'a installé (ou configuré), et peut donc le retirer. Un
 * proxy seulement trouvé sur la machine n'est jamais désinstallé par le panel.
 */
export const proxies = pgTable(
  'proxies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: proxyEnum('kind').notNull(),
    name: text('name').notNull(),
    placement: proxyPlacementEnum('placement').notNull().default('target'),
    hostTargetId: uuid('host_target_id').references(() => targets.id, { onDelete: 'cascade' }),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    encryptedSecrets: text('encrypted_secrets'),
    managed: boolean('managed').notNull().default(false),
    status: proxyStatusEnum('status').notNull().default('unknown'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastCheckError: text('last_check_error'),
    /** Le dernier « Tester », point par point. */
    lastCheck: jsonb('last_check').$type<Record<string, unknown> | null>(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('proxies_host_target_unique')
      .on(table.hostTargetId)
      .where(sql`${table.hostTargetId} is not null`),
    check(
      'proxies_target_has_host',
      sql`${table.placement} <> 'target' or ${table.hostTargetId} is not null`,
    ),
  ],
);

/**
 * Les domaines : un nom, une application, une cible.
 *
 * **Unique par nom**, et c'est la base qui le tient : deux applications ne
 * peuvent pas réclamer le même domaine, même au même instant — le perdant
 * reçoit une violation 23505, comme pour les ports. La route survit aux
 * redéploiements ; elle disparaît avec l'application, avec la cible, ou à la
 * destruction du déploiement qu'elle sert.
 */
export const routes = pgTable(
  'routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    hostname: text('hostname').notNull().unique(),
    tls: boolean('tls').notNull().default(true),
    redirectHttps: boolean('redirect_https').notNull().default(true),
    status: routeStatusEnum('status').notNull().default('pending'),
    lastError: text('last_error'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    certificate: jsonb('certificate').$type<RouteCertificate | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('routes_couple_idx').on(table.applicationId, table.targetId)],
);

export type ProxyRow = typeof proxies.$inferSelect;
export type RouteRow = typeof routes.$inferSelect;
