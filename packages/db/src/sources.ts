import {
  SOURCE_PROVIDER_KINDS,
  decrypt,
  githubWebUrl,
  repositoryWebUrl,
  sourceRepositorySchema,
  type AppSpec,
  type SourceConnectionSecrets,
  type SpecChange,
  invalid,
} from '@pupitre/core';
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { targets } from './schema/infra.js';
import {
  applicationSourceTargets,
  applicationSources,
  sourceConnections,
  sourceProposals,
} from './schema/sources.js';

/**
 * Linked repositories: the connection to the provider, the application ↔ branch
 * links, and the commits waiting for approval.
 *
 * Nothing here talks to GitHub: this module stores what the worker and the panel
 * learned from it. See `@pupitre/core` → `sources/` for the contract.
 */

export type SourceConnection = typeof sourceConnections.$inferSelect;
export type ApplicationSource = typeof applicationSources.$inferSelect;
export type SourceProposal = typeof sourceProposals.$inferSelect;
export type SourceMode = ApplicationSource['mode'];

// ─── connection ───────────────────────────────────────────────────────────────

export async function getSourceConnection(
  provider: SourceConnection['provider'] = 'github',
  db: Database = getDb(),
): Promise<SourceConnection | null> {
  const [row] = await db
    .select()
    .from(sourceConnections)
    .where(eq(sourceConnections.provider, provider));
  return row ?? null;
}

/**
 * A connection's secrets, decrypted on the spot: enough to build its client
 * (`createSourceProvider`). The result is stored nowhere and never logged.
 */
export function sourceConnectionSecrets(connection: SourceConnection): SourceConnectionSecrets {
  switch (connection.provider) {
    case 'github':
      if (connection.appId === null || !connection.privateKeyEncrypted) {
        throw new Error('incomplete GitHub connection: App or private key missing');
      }
      return {
        provider: 'github',
        appId: connection.appId,
        privateKey: decrypt(connection.privateKeyEncrypted),
        apiUrl: connection.apiUrl,
      };
    case 'gitea':
      if (!connection.tokenEncrypted)
        throw new Error('incomplete Gitea connection: token missing');
      return {
        provider: 'gitea',
        baseUrl: connection.apiUrl ?? connection.htmlUrl,
        token: decrypt(connection.tokenEncrypted),
      };
    case 'gitlab':
      if (!connection.tokenEncrypted)
        throw new Error('incomplete GitLab connection: token missing');
      return {
        provider: 'gitlab',
        baseUrl: connection.apiUrl ?? connection.htmlUrl,
        token: decrypt(connection.tokenEncrypted),
      };
  }
}

/**
 * A connection's forge web address: github.com, a GitHub Enterprise, a Gitea
 * forge, a GitLab instance.
 */
export function sourceConnectionWebUrl(connection: SourceConnection): string {
  return connection.provider === 'github'
    ? githubWebUrl(connection.apiUrl)
    : (connection.apiUrl ?? connection.htmlUrl);
}

/** The web address of a repository of this connection. */
export function sourceRepositoryUrl(connection: SourceConnection, fullName: string): string {
  return repositoryWebUrl(sourceConnectionWebUrl(connection), fullName);
}

/** The instance's connections, one per provider. */
export async function listSourceConnections(db: Database = getDb()): Promise<SourceConnection[]> {
  return db.select().from(sourceConnections).orderBy(asc(sourceConnections.provider));
}

export async function getSourceConnectionById(
  id: string,
  db: Database = getDb(),
): Promise<SourceConnection | null> {
  const [row] = await db.select().from(sourceConnections).where(eq(sourceConnections.id, id));
  return row ?? null;
}

/**
 * What is recorded of a connection. The secrets arrive **already encrypted** by
 * the caller: this module never sees a key or a token in clear. One provider's
 * fields stay empty for the other.
 */
export type SourceConnectionInput = {
  provider: SourceConnection['provider'];
  appId: number | null;
  slug: string | null;
  name: string;
  htmlUrl: string;
  owner: string;
  apiUrl: string | null;
  privateKeyEncrypted: string | null;
  tokenEncrypted: string | null;
  createdBy: string | null;
};

/** One connection per provider: saving a new one replaces the old one. */
export async function saveSourceConnection(
  input: SourceConnectionInput,
  db: Database = getDb(),
): Promise<SourceConnection> {
  const [row] = await db
    .insert(sourceConnections)
    .values(input)
    .onConflictDoUpdate({
      target: sourceConnections.provider,
      set: { ...input, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("saveSourceConnection: the write returned nothing");
  return row;
}

/** Removes the connection; its links go with it (cascade). */
export async function deleteSourceConnection(
  provider: SourceConnection['provider'] = 'github',
  db: Database = getDb(),
): Promise<{ connection: SourceConnection; sources: number } | null> {
  return db.transaction(async (tx) => {
    const [connection] = await tx
      .select()
      .from(sourceConnections)
      .where(eq(sourceConnections.provider, provider));
    if (!connection) return null;
    const [count] = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(applicationSources)
      .where(eq(applicationSources.connectionId, connection.id));
    await tx.delete(sourceConnections).where(eq(sourceConnections.id, connection.id));
    return { connection, sources: count?.value ?? 0 };
  });
}

// ─── links ────────────────────────────────────────────────────────────────────

/**
 * A straightforward relative path: neither `..` nor an absolute root. It is used
 * to read a file of the repository, never to touch the disk — but a path that
 * leaves the repository makes no sense anyway.
 */
export const repoPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (path) => !path.startsWith('/') && !path.split('/').includes('..'),
    invalid('sources.specPath'),
  );

export const sourceModeSchema = z.enum(['auto', 'auto_unless_infra', 'manual']);
export const sourceDeployToSchema = z.enum(['targets', 'running', 'none']);
export type SourceDeployTo = z.infer<typeof sourceDeployToSchema>;

const sourceTargetsSchema = z
  .array(z.object({ targetId: z.string().uuid(), runtime: z.enum(['docker', 'k3s']) }))
  .max(20)
  .refine(
    (list) => new Set(list.map((entry) => entry.targetId)).size === list.length,
    invalid('sources.targetOnce'),
  );

/**
 * A link's fields, **without** default values: they only hold at creation.
 * `.partial()` on a field carrying `.default()` fills it when it is missing — a
 * `PATCH { branch }` reset the spec file, the mode, the destination, the targets
 * and the activation to their original values.
 */
const applicationSourceFields = z.object({
  repository: sourceRepositorySchema,
  /** The repository's provider; GitHub when nothing is said, as before there were two. */
  provider: z.enum(SOURCE_PROVIDER_KINDS),
  /** GitHub: the App installation that opens the repository. Nothing at Gitea or GitLab. */
  installationId: z.number().int().positive().nullable(),
  branch: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((branch) => !/\s|\.\.|^[/-]|[~^:?*[\\]/.test(branch), invalid('sources.branch')),
  specPath: repoPathSchema,
  watchPaths: z.array(repoPathSchema).max(50),
  mode: sourceModeSchema,
  /** Where a new commit goes: the link's targets, where it runs, or nowhere. */
  deployTo: sourceDeployToSchema,
  enabled: z.boolean(),
  /** The link's targets — required when a commit goes to them (`targets`). */
  targets: sourceTargetsSchema,
});

export const applicationSourceInputSchema = applicationSourceFields.extend({
  provider: applicationSourceFields.shape.provider.default('github'),
  installationId: applicationSourceFields.shape.installationId.default(null),
  specPath: applicationSourceFields.shape.specPath.default('pupitre.json'),
  watchPaths: applicationSourceFields.shape.watchPaths.default([]),
  mode: applicationSourceFields.shape.mode.default('auto_unless_infra'),
  deployTo: applicationSourceFields.shape.deployTo.default('targets'),
  enabled: applicationSourceFields.shape.enabled.default(true),
  targets: applicationSourceFields.shape.targets.default([]),
});
export type ApplicationSourceInput = z.infer<typeof applicationSourceInputSchema>;

/** A link that deploys "on its targets" must have at least one. */
export function sourceTargetsProblem(
  deployTo: SourceDeployTo,
  targets: readonly unknown[],
): string | null {
  return deployTo === 'targets' && targets.length === 0 ? 'at least one target' : null;
}

export const applicationSourceCreateSchema = applicationSourceInputSchema.superRefine(
  (input, context) => {
    const problem = sourceTargetsProblem(input.deployTo, input.targets);
    if (problem) {
      context.addIssue({
        code: 'custom',
        path: ['targets'],
        ...invalid('sources.atLeastOneTarget'),
      });
    }
  },
);

export const applicationSourcePatchSchema = applicationSourceFields
  .omit({ repository: true, installationId: true, provider: true })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, invalid('noFieldToChange'));
export type ApplicationSourcePatch = z.infer<typeof applicationSourcePatchSchema>;

export type SourceTarget = { targetId: string; runtime: 'docker' | 'k3s'; targetName: string };

export type ApplicationSourceView = ApplicationSource & {
  targets: SourceTarget[];
  pendingProposals: number;
};

export async function listSourceTargets(
  sourceIds: readonly string[],
  db: Database = getDb(),
): Promise<Map<string, SourceTarget[]>> {
  const map = new Map<string, SourceTarget[]>();
  if (sourceIds.length === 0) return map;
  const rows = await db
    .select({
      sourceId: applicationSourceTargets.sourceId,
      targetId: applicationSourceTargets.targetId,
      runtime: applicationSourceTargets.runtime,
      targetName: targets.name,
    })
    .from(applicationSourceTargets)
    .innerJoin(targets, eq(targets.id, applicationSourceTargets.targetId))
    .where(inArray(applicationSourceTargets.sourceId, [...sourceIds]))
    .orderBy(asc(targets.name));
  for (const row of rows) {
    const list = map.get(row.sourceId) ?? [];
    list.push({ targetId: row.targetId, runtime: row.runtime, targetName: row.targetName });
    map.set(row.sourceId, list);
  }
  return map;
}

async function withTargets(
  rows: ApplicationSource[],
  db: Database,
): Promise<ApplicationSourceView[]> {
  const ids = rows.map((row) => row.id);
  const [targetMap, pending] = await Promise.all([
    listSourceTargets(ids, db),
    ids.length === 0
      ? Promise.resolve([])
      : db
          .select({
            sourceId: sourceProposals.sourceId,
            value: sql<number>`count(*)::int`,
          })
          .from(sourceProposals)
          .where(and(inArray(sourceProposals.sourceId, ids), eq(sourceProposals.status, 'pending')))
          .groupBy(sourceProposals.sourceId),
  ]);
  const pendingMap = new Map(pending.map((row) => [row.sourceId, row.value]));
  return rows.map((row) => ({
    ...row,
    targets: targetMap.get(row.id) ?? [],
    pendingProposals: pendingMap.get(row.id) ?? 0,
  }));
}

export async function listApplicationSources(
  applicationId: string,
  db: Database = getDb(),
): Promise<ApplicationSourceView[]> {
  const rows = await db
    .select()
    .from(applicationSources)
    .where(eq(applicationSources.applicationId, applicationId))
    .orderBy(asc(applicationSources.createdAt));
  return withTargets(rows, db);
}

export async function getApplicationSource(
  id: string,
  db: Database = getDb(),
): Promise<ApplicationSourceView | null> {
  const [row] = await db.select().from(applicationSources).where(eq(applicationSources.id, id));
  if (!row) return null;
  const [view] = await withTargets([row], db);
  return view ?? null;
}

/** The active links, for polling. */
export async function listEnabledSources(db: Database = getDb()): Promise<ApplicationSourceView[]> {
  const rows = await db
    .select()
    .from(applicationSources)
    .where(eq(applicationSources.enabled, true))
    .orderBy(asc(applicationSources.createdAt));
  return withTargets(rows, db);
}

export class SourceBindingConflictError extends Error {
  constructor() {
    super('this application already follows this branch of this repository');
    this.name = 'SourceBindingConflictError';
  }
}

export async function createApplicationSource(
  input: ApplicationSourceInput & {
    applicationId: string;
    connectionId: string;
    createdBy: string | null;
    /** The commit the application was just created from, if any. */
    syncedSha?: string | null;
  },
  db: Database = getDb(),
): Promise<ApplicationSourceView> {
  const created = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: applicationSources.id })
      .from(applicationSources)
      .where(
        and(
          eq(applicationSources.applicationId, input.applicationId),
          eq(applicationSources.repository, input.repository),
          eq(applicationSources.branch, input.branch),
        ),
      );
    if (existing) throw new SourceBindingConflictError();

    const [row] = await tx
      .insert(applicationSources)
      .values({
        applicationId: input.applicationId,
        connectionId: input.connectionId,
        installationId: input.installationId,
        repository: input.repository,
        branch: input.branch,
        specPath: input.specPath,
        watchPaths: input.watchPaths,
        mode: input.mode,
        deployTo: input.deployTo,
        enabled: input.enabled,
        createdBy: input.createdBy,
        // An application created from the repository already carries this commit's
        // AppSpec: it is both the starting point of polling and the one whose code a
        // manual deployment builds.
        ...(input.syncedSha
          ? {
              lastSeenSha: input.syncedSha,
              syncedSha: input.syncedSha,
              syncedAt: new Date(),
              lastCheckedAt: new Date(),
            }
          : {}),
      })
      .returning();
    if (!row) throw new Error("createApplicationSource: the insert returned nothing");
    if (input.targets.length > 0) {
      await tx
        .insert(applicationSourceTargets)
        .values(input.targets.map((target) => ({ sourceId: row.id, ...target })));
    }
    return row;
  });
  const [view] = await withTargets([created], db);
  return view!;
}

export async function updateApplicationSource(
  id: string,
  patch: ApplicationSourcePatch,
  db: Database = getDb(),
): Promise<ApplicationSourceView | null> {
  const updated = await db.transaction(async (tx) => {
    const { targets: nextTargets, ...fields } = patch;
    const [current] = await tx.select().from(applicationSources).where(eq(applicationSources.id, id));
    if (!current) return null;

    // Changing branch is starting from scratch: the next pass reads the new branch's
    // head without deploying anything.
    const branchChanged = fields.branch !== undefined && fields.branch !== current.branch;
    const [row] = await tx
      .update(applicationSources)
      .set({
        ...fields,
        ...(branchChanged ? { lastSeenSha: null, lastEtag: null, lastError: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(applicationSources.id, id))
      .returning();
    if (nextTargets) {
      await tx.delete(applicationSourceTargets).where(eq(applicationSourceTargets.sourceId, id));
      if (nextTargets.length > 0) {
        await tx
          .insert(applicationSourceTargets)
          .values(nextTargets.map((target) => ({ sourceId: id, ...target })));
      }
    }
    return row ?? null;
  });
  if (!updated) return null;
  const [view] = await withTargets([updated], db);
  return view ?? null;
}

export async function deleteApplicationSource(
  id: string,
  db: Database = getDb(),
): Promise<ApplicationSource | null> {
  const [row] = await db.delete(applicationSources).where(eq(applicationSources.id, id)).returning();
  return row ?? null;
}

/** What a polling pass learned about a link. */
export async function recordSourceCheck(
  id: string,
  result: {
    /** The commit now handled, if it changed. */
    sha?: string;
    etag?: string | null;
    error: string | null;
  },
  db: Database = getDb(),
): Promise<void> {
  const now = new Date();
  await db
    .update(applicationSources)
    .set({
      lastCheckedAt: now,
      lastError: result.error,
      ...(result.sha !== undefined ? { lastSeenSha: result.sha, lastChangeAt: now } : {}),
      ...(result.etag !== undefined ? { lastEtag: result.etag } : {}),
    })
    .where(eq(applicationSources.id, id));
}

/**
 * Reserves a commit to handle it: only succeeds if the link is still at the
 * `previous` commit. Two overlapping polling passes read the same novelty; only
 * one reserves it, only one deploys. It is a conditional write, not a lock:
 * nothing to release if the worker goes down.
 */
export async function claimSourceCommit(
  id: string,
  previous: string | null,
  next: string,
  etag: string | null,
  db: Database = getDb(),
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(applicationSources)
    .set({ lastSeenSha: next, lastEtag: etag, lastCheckedAt: now, lastChangeAt: now })
    .where(
      and(
        eq(applicationSources.id, id),
        previous === null
          ? sql`${applicationSources.lastSeenSha} is null`
          : eq(applicationSources.lastSeenSha, previous),
      ),
    )
    .returning({ id: applicationSources.id });
  return rows.length > 0;
}

// ─── commits awaiting approval ────────────────────────────────────────────────

export type SourceProposalInput = {
  sourceId: string;
  sha: string;
  commitMessage: string | null;
  commitAuthor: string | null;
  commitUrl: string | null;
  appSpec: AppSpec;
  reason: 'manual' | 'infra';
  changes: SpecChange[];
};

/**
 * Stores a pending commit. A more recent commit on the same link makes the
 * previous ones moot: one does not approve a version that is no longer the
 * branch's head.
 */
export async function createSourceProposal(
  input: SourceProposalInput,
  db: Database = getDb(),
): Promise<SourceProposal | null> {
  return db.transaction(async (tx) => {
    await tx
      .update(sourceProposals)
      .set({ status: 'superseded', decidedAt: new Date() })
      .where(
        and(
          eq(sourceProposals.sourceId, input.sourceId),
          eq(sourceProposals.status, 'pending'),
          ne(sourceProposals.sha, input.sha),
        ),
      );
    const [row] = await tx
      .insert(sourceProposals)
      .values(input)
      .onConflictDoNothing({ target: [sourceProposals.sourceId, sourceProposals.sha] })
      .returning();
    return row ?? null;
  });
}

export async function getSourceProposal(
  id: string,
  db: Database = getDb(),
): Promise<SourceProposal | null> {
  const [row] = await db.select().from(sourceProposals).where(eq(sourceProposals.id, id));
  return row ?? null;
}

/** The pending commits of an application's links, the most recent first. */
export async function listPendingProposals(
  applicationId: string,
  db: Database = getDb(),
): Promise<SourceProposal[]> {
  return db
    .select({ proposal: sourceProposals })
    .from(sourceProposals)
    .innerJoin(applicationSources, eq(applicationSources.id, sourceProposals.sourceId))
    .where(
      and(
        eq(applicationSources.applicationId, applicationId),
        eq(sourceProposals.status, 'pending'),
      ),
    )
    .orderBy(desc(sourceProposals.createdAt))
    .then((rows) => rows.map((row) => row.proposal));
}

/**
 * Decides a pending commit. Only touches a proposal still `pending`: two
 * simultaneous clicks do not deploy twice.
 */
export async function decideSourceProposal(
  id: string,
  status: 'approved' | 'dismissed',
  decidedBy: string | null,
  db: Database = getDb(),
): Promise<SourceProposal | null> {
  const [row] = await db
    .update(sourceProposals)
    .set({ status, decidedBy, decidedAt: new Date() })
    .where(and(eq(sourceProposals.id, id), eq(sourceProposals.status, 'pending')))
    .returning();
  return row ?? null;
}

/**
 * Makes a link's pending commits moot — when a more recent commit was just
 * deployed, the previous ones no longer make sense.
 */
export async function supersedePendingProposals(
  sourceId: string,
  exceptId: string | null,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(sourceProposals)
    .set({ status: 'superseded', decidedAt: new Date() })
    .where(
      and(
        eq(sourceProposals.sourceId, sourceId),
        eq(sourceProposals.status, 'pending'),
        ...(exceptId ? [ne(sourceProposals.id, exceptId)] : []),
      ),
    );
}

/** The number of links, all applications together. */
/** The instance's links — or a connection's. */
export async function countApplicationSources(
  connectionId?: string,
  db: Database = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(applicationSources)
    .where(connectionId ? eq(applicationSources.connectionId, connectionId) : undefined);
  return row?.value ?? 0;
}

// ─── the application's commit ────────────────────────────────────────────────

/** The application now carries the AppSpec of this commit of the link. */
export async function markSourceSynced(
  id: string,
  sha: string,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(applicationSources)
    .set({ syncedSha: sha, syncedAt: new Date(), updatedAt: new Date() })
    .where(eq(applicationSources.id, id));
}

/**
 * The link the application's current version comes from: the one that synced it
 * last. A manually started deployment builds its commit's code. `null`: the
 * application comes from no repository.
 */
export async function getSyncedSource(
  applicationId: string,
  db: Database = getDb(),
): Promise<ApplicationSourceView | null> {
  const [row] = await db
    .select()
    .from(applicationSources)
    .where(
      and(
        eq(applicationSources.applicationId, applicationId),
        isNotNull(applicationSources.syncedSha),
      ),
    )
    .orderBy(desc(applicationSources.syncedAt))
    .limit(1);
  if (!row) return null;
  const [view] = await withTargets([row], db);
  return view ?? null;
}
