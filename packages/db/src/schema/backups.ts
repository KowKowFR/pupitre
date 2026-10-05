import type { BackupManifest, BackupRetention } from '@pupitre/core';
import { bigint, boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  backupDestinationKindEnum,
  backupKindEnum,
  backupModeEnum,
  backupStatusEnum,
  backupTriggerEnum,
} from '../enums.js';
import { users } from './auth.js';
import { deployments } from './deployments.js';
import { applications, targets } from './infra.js';

/**
 * Where backups go. A single active destination at a time — the table allows
 * several so that changing it is not a migration.
 *
 * `config` carries what is shown (endpoint, bucket, host, path);
 * `encrypted_secrets` what is never shown (access keys, password, private key),
 * encrypted under `MASTER_KEY` like the targets' SSH credentials. The API says
 * which secrets are filled in, never their value.
 */
export const backupDestinations = pgTable('backup_destinations', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: backupDestinationKindEnum('kind').notNull(),
  name: text('name').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  encryptedSecrets: text('encrypted_secrets'),
  /** Filled-in secret fields — their names only. */
  secretFields: jsonb('secret_fields').$type<string[]>().notNull().default([]),
  enabled: boolean('enabled').notNull().default(true),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastCheckError: text('last_check_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * How an application is backed up. Absent: nothing is done — it is the operator
 * who enables it, at the first deployment or later.
 */
export const backupPolicies = pgTable('backup_policies', {
  applicationId: uuid('application_id')
    .primaryKey()
    .references(() => applications.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  mode: backupModeEnum('mode').notNull().default('hot'),
  beforeDeploy: boolean('before_deploy').notNull().default(false),
  retention: jsonb('retention').$type<BackupRetention>().notNull(),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The backup history — what was placed, where, and what it was.
 *
 * The destination is authoritative for the content: each backup is stored there
 * with its manifest, and can be read without this table. The row here is the
 * panel's index: what it shows, what retention erases.
 *
 * A deleted application leaves its backups (`set null`): erasing an application
 * is not erasing what would allow bringing it back.
 */
export const backups = pgTable(
  'backups',
  {
    id: uuid('id').primaryKey(),
    kind: backupKindEnum('kind').notNull(),
    applicationId: uuid('application_id').references(() => applications.id, {
      onDelete: 'set null',
    }),
    /** The slug, kept: it still names a deleted application's backup. */
    applicationSlug: text('application_slug'),
    targetId: uuid('target_id').references(() => targets.id, { onDelete: 'set null' }),
    deploymentId: uuid('deployment_id').references(() => deployments.id, {
      onDelete: 'set null',
    }),
    destinationId: uuid('destination_id').references(() => backupDestinations.id, {
      onDelete: 'set null',
    }),
    trigger: backupTriggerEnum('trigger').notNull(),
    mode: backupModeEnum('mode'),
    status: backupStatusEnum('status').notNull().default('running'),
    /** The backup's folder on the destination, relative to its prefix. */
    location: text('location').notNull(),
    manifest: jsonb('manifest').$type<BackupManifest>(),
    /**
     * The fingerprint of the `MASTER_KEY` its files are encrypted under
     * (`keyIdOf()`). `null` for the backups made before rotation existed: their
     * files do not say, they are read with each key in turn. Tells `crypto status`
     * whether `MASTER_KEY_PREVIOUS` is still needed.
     */
    keyId: text('key_id'),
    bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
    error: text('error'),
    requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('backups_application_started_idx').on(t.applicationId, t.startedAt.desc()),
    index('backups_kind_started_idx').on(t.kind, t.startedAt.desc()),
    index('backups_status_idx').on(t.status),
  ],
);

export type BackupDestinationRow = typeof backupDestinations.$inferSelect;
export type BackupPolicyRow = typeof backupPolicies.$inferSelect;
export type BackupRow = typeof backups.$inferSelect;
