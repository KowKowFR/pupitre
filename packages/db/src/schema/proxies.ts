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
import {
  proxyEnum,
  proxyPlacementEnum,
  proxyStatusEnum,
  routeStatusEnum,
  wafModeEnum,
} from '../enums.js';
import { users } from './auth.js';
import { applications, targets } from './infra.js';

/**
 * The reverse proxies the panel drives.
 *
 * A proxy "on the target" serves the machine it runs on — only one per machine,
 * held by a partial unique index. `config` carries what is shown (mode, folder,
 * entry points, resolver, ACME settings); `encrypted_secrets`, what is never
 * shown — nothing for Traefik, API credentials for upcoming proxies —, encrypted
 * under `MASTER_KEY`.
 *
 * `managed`: Pupitre installed (or configured) it, and can therefore remove it.
 * A proxy only found on the machine is never uninstalled by the panel.
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
    /** The last "Test", point by point. */
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
 * The domains: a name, an application, a target.
 *
 * **Unique per name**, and it is the database that holds it: two applications
 * cannot claim the same domain, even at the same instant — the loser gets a
 * 23505 violation, as for ports. The route survives redeploys; it disappears
 * with the application, with the target, or at the destruction of the
 * deployment it serves.
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
    /** For a proxy that is also a WAF: block, only detect, or relay. */
    waf: wafModeEnum('waf').notNull().default('block'),
    status: routeStatusEnum('status').notNull().default('pending'),
    lastError: text('last_error'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    certificate: jsonb('certificate').$type<RouteCertificate | null>(),
    /**
     * The expiry of the certificate already reported as about to expire, or `null`.
     * One alert per certificate: the next probe sees the same expiry and keeps
     * quiet; a renewed certificate sets the column back to `null`.
     */
    certificateAlert: text('certificate_alert'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('routes_couple_idx').on(table.applicationId, table.targetId)],
);

/**
 * The central proxy: a machine served by **another**'s reverse proxy. One row per
 * machine served that way — a machine that has its own proxy has none.
 *
 * `address`: how the proxy's machine reaches this one — preferably a private
 * address. `source_address`: the address it arrives from, seen from this one —
 * the application's port is opened to it alone. `bindable`: `address` is an
 * address of this machine, the port can be published there so that it is only
 * reachable that way. The last two are noted by the link's test.
 */
export const proxyLinks = pgTable('proxy_links', {
  targetId: uuid('target_id')
    .primaryKey()
    .references(() => targets.id, { onDelete: 'cascade' }),
  proxyId: uuid('proxy_id')
    .notNull()
    .references(() => proxies.id, { onDelete: 'cascade' }),
  address: text('address').notNull(),
  sourceAddress: text('source_address'),
  bindable: boolean('bindable').notNull().default(false),
  status: proxyStatusEnum('status').notNull().default('unknown'),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastCheckError: text('last_check_error'),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ProxyLinkRow = typeof proxyLinks.$inferSelect;
export type ProxyRow = typeof proxies.$inferSelect;
export type RouteRow = typeof routes.$inferSelect;
