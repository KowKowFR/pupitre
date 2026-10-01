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
 * Où vont les sauvegardes. Une seule destination active à la fois — la table
 * en admet plusieurs pour qu'en changer ne soit pas une migration.
 *
 * `config` porte ce qui se montre (point de terminaison, bucket, hôte, chemin) ;
 * `encrypted_secrets` ce qui ne se montre jamais (clés d'accès, mot de passe,
 * clé privée), chiffré sous `MASTER_KEY` comme les credentials SSH des cibles.
 * L'API dit quels secrets sont renseignés, jamais leur valeur.
 */
export const backupDestinations = pgTable('backup_destinations', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: backupDestinationKindEnum('kind').notNull(),
  name: text('name').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  encryptedSecrets: text('encrypted_secrets'),
  /** Champs secrets renseignés — leurs noms seulement. */
  secretFields: jsonb('secret_fields').$type<string[]>().notNull().default([]),
  enabled: boolean('enabled').notNull().default(true),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastCheckError: text('last_check_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Comment une application est sauvegardée. Absente : rien n'est fait — c'est
 * l'opérateur qui l'active, au premier déploiement ou plus tard.
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
 * L'historique des sauvegardes — ce qui a été déposé, où, et ce que c'était.
 *
 * La destination fait foi pour le contenu : chaque sauvegarde y est rangée
 * avec son manifeste, et se relit sans cette table. La ligne d'ici est
 * l'index du panel : ce qu'il montre, ce que la rétention efface.
 *
 * Une application supprimée laisse ses sauvegardes (`set null`) : effacer une
 * application n'est pas effacer ce qui permettrait de la faire revenir.
 */
export const backups = pgTable(
  'backups',
  {
    id: uuid('id').primaryKey(),
    kind: backupKindEnum('kind').notNull(),
    applicationId: uuid('application_id').references(() => applications.id, {
      onDelete: 'set null',
    }),
    /** Le slug, conservé : il nomme encore la sauvegarde d'une application supprimée. */
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
    /** Le dossier de la sauvegarde sur la destination, relatif à son préfixe. */
    location: text('location').notNull(),
    manifest: jsonb('manifest').$type<BackupManifest>(),
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
