import type {
  AppSpec,
  SourceArchiveFormat,
  SourceArchiveRejection,
  SourceArchiveReport,
  SpecChange,
} from '@pupitre/core';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  runtimeEnum,
  sourceArchiveStatusEnum,
  sourceDeployToEnum,
  sourceModeEnum,
  sourceProposalStatusEnum,
  sourceProviderEnum,
} from '../enums.js';
import { users } from './auth.js';
import { bytea } from './columns.js';
import { applications, targets } from './infra.js';

/**
 * L'intégration avec un fournisseur de code — pour GitHub, une GitHub App.
 * Une par fournisseur et par instance.
 *
 * La clé privée de l'App est chiffrée comme les credentials SSH (AES-256-GCM,
 * `MASTER_KEY`) : elle ouvre la lecture de dépôts privés, elle ne sort jamais
 * en clair, ni dans une réponse, ni dans un log.
 */
export const sourceConnections = pgTable(
  'source_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: sourceProviderEnum('provider').notNull(),
    appId: integer('app_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    htmlUrl: text('html_url').notNull(),
    /** Le compte (personne ou organisation) propriétaire de l'App. */
    owner: text('owner').notNull(),
    /** API d'un GitHub Enterprise ; `null` pour github.com. */
    apiUrl: text('api_url'),
    privateKeyEncrypted: text('private_key_encrypted').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('source_connections_provider_idx').on(t.provider)],
);

/**
 * Une liaison : une application suit une branche d'un dépôt.
 *
 * Le dépôt dit **quoi** (le `pupitre.json` à `spec_path`) ; la liaison dit
 * **où** (ses cibles) et **quand** (`mode`). Une application peut suivre
 * plusieurs branches — `main` vers la production, `staging` vers la recette —,
 * chacune avec ses cibles et son mode.
 */
export const applicationSources = pgTable(
  'application_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => sourceConnections.id, { onDelete: 'cascade' }),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    /** `owner/name`. */
    repository: text('repository').notNull(),
    branch: text('branch').notNull(),
    /** Chemin du `pupitre.json`, relatif à la racine du dépôt. */
    specPath: text('spec_path').notNull().default('pupitre.json'),
    /** Motifs de chemins dont un changement concerne l'application (monorepo). */
    watchPaths: jsonb('watch_paths').$type<string[]>().notNull().default([]),
    mode: sourceModeEnum('mode').notNull().default('auto_unless_infra'),
    /** Où part un nouveau commit — voir `sourceDeployToEnum`. */
    deployTo: sourceDeployToEnum('deploy_to').notNull().default('targets'),
    enabled: boolean('enabled').notNull().default(true),
    /** Le dernier commit traité : la prochaine comparaison part de lui. */
    lastSeenSha: text('last_seen_sha'),
    /**
     * Le commit dont l'application porte l'AppSpec — celui dont un déploiement
     * lancé à la main construit le code. Peut précéder `lastSeenSha` : un
     * commit en attente de validation n'est pas encore celui de l'application.
     */
    syncedSha: text('synced_sha'),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    /** L'ETag de la dernière réponse : « rien de neuf » ne coûte alors rien. */
    lastEtag: text('last_etag'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    /** Dernier commit traité (déployé, proposé ou ignoré) : quand. */
    lastChangeAt: timestamp('last_change_at', { withTimezone: true }),
    /** Ce qui a échoué au dernier passage, en clair. `null` quand tout va bien. */
    lastError: text('last_error'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('application_sources_application_idx').on(t.applicationId),
    uniqueIndex('application_sources_branch_idx').on(t.applicationId, t.repository, t.branch),
  ],
);

/** Les cibles d'une liaison, chacune avec son runtime. */
export const applicationSourceTargets = pgTable(
  'application_source_targets',
  {
    sourceId: uuid('source_id')
      .notNull()
      .references(() => applicationSources.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    runtime: runtimeEnum('runtime').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.targetId] })],
);

/**
 * Un commit qui attend une validation humaine : parce que la liaison le veut
 * (`manual`), ou parce qu'il touche à l'infrastructure (`auto_unless_infra`).
 * L'AppSpec du commit est gardée telle qu'elle a été lue : valider déploie
 * exactement ce qui a été montré.
 */
export const sourceProposals = pgTable(
  'source_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => applicationSources.id, { onDelete: 'cascade' }),
    sha: text('sha').notNull(),
    commitMessage: text('commit_message'),
    commitAuthor: text('commit_author'),
    commitUrl: text('commit_url'),
    appSpec: jsonb('app_spec').$type<AppSpec>().notNull(),
    /** `manual` : la liaison demande toujours une validation. `infra` : le commit touche à l'infra. */
    reason: text('reason').$type<'manual' | 'infra'>().notNull(),
    changes: jsonb('changes').$type<SpecChange[]>().notNull().default([]),
    status: sourceProposalStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('source_proposals_commit_idx').on(t.sourceId, t.sha),
    index('source_proposals_status_idx').on(t.status),
  ],
);

/**
 * Le code d'une application, téléversé dans le panel : l'autre voie d'entrée
 * du code, pour une application qui n'a pas de dépôt lié.
 *
 * Une ligne par envoi. La plus récente est le code de l'application : celui
 * qu'un déploiement construit. Les précédentes restent, peu nombreuses
 * (`SOURCE_ARCHIVES_KEPT`), pour qu'un redéploiement d'une version récente
 * retrouve son code. Les octets vivent en base, par morceaux — ni le panel ni
 * le worker n'ont de disque en commun, et une sauvegarde du panel les emporte.
 */
export const sourceArchives = pgTable(
  'source_archives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** Le nom du fichier envoyé : une étiquette, rien ne s'écrit jamais sous ce nom. */
    name: text('name').notNull(),
    /** Lu dans les octets à l'arrivée, jamais dans le nom ni dans l'en-tête. */
    format: text('format').$type<SourceArchiveFormat>().notNull(),
    status: sourceArchiveStatusEnum('status').notNull().default('receiving'),
    /** Les octets reçus et leur SHA-256 : ce qu'un `sha256sum` local doit retrouver. */
    uploadedBytes: bigint('uploaded_bytes', { mode: 'number' }).notNull().default(0),
    sha256: text('sha256'),
    /** L'archive propre, refaite par le worker : celle que les déploiements déposent. */
    archiveBytes: bigint('archive_bytes', { mode: 'number' }),
    report: jsonb('report').$type<SourceArchiveReport>(),
    /** Pourquoi elle est refusée : un code, et le chemin en cause. */
    rejection: text('rejection').$type<SourceArchiveRejection>(),
    rejectionDetail: text('rejection_detail'),
    uploadedBy: text('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    inspectedAt: timestamp('inspected_at', { withTimezone: true }),
  },
  (t) => [index('source_archives_application_idx').on(t.applicationId, t.createdAt)],
);

/**
 * Les octets d'une archive, par morceaux d'un mégaoctet : on les écrit au fil
 * de l'envoi et on les relit un à un, sans jamais tenir l'archive entière en
 * mémoire. `upload` : ce qui a été reçu, le temps de la lecture. `tree` :
 * l'archive propre, seule à servir ensuite.
 */
export const sourceArchiveChunks = pgTable(
  'source_archive_chunks',
  {
    archiveId: uuid('archive_id')
      .notNull()
      .references(() => sourceArchives.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'upload' | 'tree'>().notNull(),
    seq: integer('seq').notNull(),
    data: bytea('data').notNull(),
  },
  (t) => [primaryKey({ columns: [t.archiveId, t.kind, t.seq] })],
);
