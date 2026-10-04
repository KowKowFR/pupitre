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
 * The integration with a code provider — a GitHub App, or the token of a Gitea /
 * Forgejo or GitLab account. One per provider and per instance.
 *
 * Its secrets — the App's private key, a token — are encrypted like SSH
 * credentials (AES-256-GCM, `MASTER_KEY`): they open read access to private
 * repositories, they never go out in clear, neither in a response nor in a log.
 * One provider's columns are empty for the other.
 */
export const sourceConnections = pgTable(
  'source_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: sourceProviderEnum('provider').notNull(),
    /** GitHub : l'App. */
    appId: integer('app_id'),
    slug: text('slug'),
    name: text('name').notNull(),
    /** GitHub: the App's page. Gitea, GitLab: the forge's address. */
    htmlUrl: text('html_url').notNull(),
    /** GitHub: the App's owner. Gitea, GitLab: the token's account. */
    owner: text('owner').notNull(),
    /**
     * GitHub: a GitHub Enterprise's API, `null` for github.com. Gitea, GitLab: the
     * forge's address.
     */
    apiUrl: text('api_url'),
    /** GitHub: the App's private key, encrypted. */
    privateKeyEncrypted: text('private_key_encrypted'),
    /** Gitea, GitLab: the access token, encrypted. */
    tokenEncrypted: text('token_encrypted'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('source_connections_provider_idx').on(t.provider)],
);

/**
 * A link: an application follows a branch of a repository.
 *
 * The repository says **what** (the `pupitre.json` at `spec_path`); the link
 * says **where** (its targets) and **when** (`mode`). An application can follow
 * several branches — `main` toward production, `staging` toward acceptance —,
 * each with its targets and its mode.
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
    /** GitHub: the App installation that opens the repository. `null` at Gitea and GitLab. */
    installationId: bigint('installation_id', { mode: 'number' }),
    /** `owner/name`. */
    repository: text('repository').notNull(),
    branch: text('branch').notNull(),
    /** Path of the `pupitre.json`, relative to the repository's root. */
    specPath: text('spec_path').notNull().default('pupitre.json'),
    /** Path patterns whose change concerns the application (monorepo). */
    watchPaths: jsonb('watch_paths').$type<string[]>().notNull().default([]),
    mode: sourceModeEnum('mode').notNull().default('auto_unless_infra'),
    /** Where a new commit goes — see `sourceDeployToEnum`. */
    deployTo: sourceDeployToEnum('deploy_to').notNull().default('targets'),
    enabled: boolean('enabled').notNull().default(true),
    /** The last commit handled: the next comparison starts from it. */
    lastSeenSha: text('last_seen_sha'),
    /**
     * The commit whose AppSpec the application carries — the one whose code a
     * manually started deployment builds. Can precede `lastSeenSha`: a commit
     * waiting for approval is not yet the application's.
     */
    syncedSha: text('synced_sha'),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    /** The last response's ETag: "nothing new" then costs nothing. */
    lastEtag: text('last_etag'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    /** Last commit handled (deployed, proposed or ignored): when. */
    lastChangeAt: timestamp('last_change_at', { withTimezone: true }),
    /** What failed at the last pass, in clear. `null` when all is well. */
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

/** A link's targets, each with its runtime. */
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
 * A commit waiting for human approval: because the link wants it (`manual`), or
 * because it touches the infrastructure (`auto_unless_infra`). The commit's
 * AppSpec is kept as it was read: approving deploys exactly what was shown.
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
    /** `manual`: the link always asks for approval. `infra`: the commit touches the infra. */
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
 * An application's code, uploaded into the panel: the other way in for code, for
 * an application without a linked repository.
 *
 * One row per upload. The most recent is the application's code: the one a
 * deployment builds. The previous ones stay, few in number
 * (`SOURCE_ARCHIVES_KEPT`), so that redeploying a recent version finds its code.
 * The bytes live in the database, in chunks — neither the panel nor the worker
 * share a disk, and a panel backup takes them along.
 */
export const sourceArchives = pgTable(
  'source_archives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** The name of the uploaded file: a label, nothing is ever written under that name. */
    name: text('name').notNull(),
    /** Read from the bytes on arrival, never from the name or the header. */
    format: text('format').$type<SourceArchiveFormat>().notNull(),
    status: sourceArchiveStatusEnum('status').notNull().default('receiving'),
    /** The bytes received and their SHA-256: what a local `sha256sum` must find. */
    uploadedBytes: bigint('uploaded_bytes', { mode: 'number' }).notNull().default(0),
    sha256: text('sha256'),
    /** The clean archive, remade by the worker: the one deployments place. */
    archiveBytes: bigint('archive_bytes', { mode: 'number' }),
    report: jsonb('report').$type<SourceArchiveReport>(),
    /** Why it is refused: a code, and the path at fault. */
    rejection: text('rejection').$type<SourceArchiveRejection>(),
    rejectionDetail: text('rejection_detail'),
    uploadedBy: text('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    inspectedAt: timestamp('inspected_at', { withTimezone: true }),
  },
  (t) => [index('source_archives_application_idx').on(t.applicationId, t.createdAt)],
);

/**
 * The bytes of an archive, in one-megabyte chunks: they are written as the
 * upload goes and read back one by one, without ever holding the whole archive
 * in memory. `upload`: what was received, while it is read. `tree`: the clean
 * archive, the only one used afterwards.
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
