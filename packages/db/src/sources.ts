import {
  SOURCE_PROVIDER_KINDS,
  decrypt,
  githubWebUrl,
  repositoryWebUrl,
  type AppSpec,
  type SourceConnectionSecrets,
  type SpecChange,
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
 * Dépôts liés : la connexion au fournisseur, les liaisons application ↔
 * branche, et les commits qui attendent une validation.
 *
 * Rien ici ne parle à GitHub : ce module range ce que le worker et le panel en
 * ont appris. Voir `@pupitre/core` → `sources/` pour le contrat.
 */

export type SourceConnection = typeof sourceConnections.$inferSelect;
export type ApplicationSource = typeof applicationSources.$inferSelect;
export type SourceProposal = typeof sourceProposals.$inferSelect;
export type SourceMode = ApplicationSource['mode'];

// ─── connexion ────────────────────────────────────────────────────────────────

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
 * Les secrets d'une connexion, déchiffrés à l'instant : de quoi fabriquer son
 * client (`createSourceProvider`). Le résultat ne se range nulle part et ne
 * se journalise jamais.
 */
export function sourceConnectionSecrets(connection: SourceConnection): SourceConnectionSecrets {
  switch (connection.provider) {
    case 'github':
      if (connection.appId === null || !connection.privateKeyEncrypted) {
        throw new Error('connexion GitHub incomplète : App ou clé privée manquante');
      }
      return {
        provider: 'github',
        appId: connection.appId,
        privateKey: decrypt(connection.privateKeyEncrypted),
        apiUrl: connection.apiUrl,
      };
    case 'gitea':
      if (!connection.tokenEncrypted)
        throw new Error('connexion Gitea incomplète : jeton manquant');
      return {
        provider: 'gitea',
        baseUrl: connection.apiUrl ?? connection.htmlUrl,
        token: decrypt(connection.tokenEncrypted),
      };
  }
}

/** L'adresse web de la forge d'une connexion : github.com, un GitHub Enterprise, une forge Gitea. */
export function sourceConnectionWebUrl(connection: SourceConnection): string {
  return connection.provider === 'github'
    ? githubWebUrl(connection.apiUrl)
    : (connection.apiUrl ?? connection.htmlUrl);
}

/** L'adresse web d'un dépôt de cette connexion. */
export function sourceRepositoryUrl(connection: SourceConnection, fullName: string): string {
  return repositoryWebUrl(sourceConnectionWebUrl(connection), fullName);
}

/** Les connexions de l'instance, une par fournisseur. */
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
 * Ce qu'on enregistre d'une connexion. Les secrets arrivent **déjà chiffrés**
 * par l'appelant : ce module ne voit jamais une clé ni un jeton en clair. Les
 * champs d'un fournisseur restent vides pour l'autre.
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

/** Une connexion par fournisseur : en enregistrer une nouvelle remplace l'ancienne. */
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
  if (!row) throw new Error("saveSourceConnection : l'écriture n'a rien retourné");
  return row;
}

/** Retire la connexion ; ses liaisons partent avec elle (cascade). */
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

// ─── liaisons ─────────────────────────────────────────────────────────────────

/**
 * Un chemin relatif sans détour : ni `..`, ni racine absolue. Il sert à lire un
 * fichier du dépôt, jamais à toucher le disque — mais un chemin qui sort du
 * dépôt n'a de toute façon aucun sens.
 */
export const repoPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), {
    message: 'chemin relatif à la racine du dépôt, sans « .. »',
  });

export const sourceModeSchema = z.enum(['auto', 'auto_unless_infra', 'manual']);
export const sourceDeployToSchema = z.enum(['targets', 'running', 'none']);
export type SourceDeployTo = z.infer<typeof sourceDeployToSchema>;

const sourceTargetsSchema = z
  .array(z.object({ targetId: z.string().uuid(), runtime: z.enum(['docker', 'k3s']) }))
  .max(20)
  .refine(
    (list) => new Set(list.map((entry) => entry.targetId)).size === list.length,
    'une cible ne se choisit qu’une fois',
  );

/**
 * Les champs d'une liaison, **sans** valeurs par défaut : elles ne valent qu'à
 * la création. `.partial()` sur un champ porteur de `.default()` le remplit
 * quand il manque — un `PATCH { branch }` remettait le fichier de spec, le
 * mode, la destination, les cibles et l'activation à leurs valeurs d'origine.
 */
const applicationSourceFields = z.object({
  repository: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'dépôt attendu sous la forme propriétaire/nom'),
  /** Le fournisseur du dépôt ; GitHub quand rien n'est dit, comme avant qu'il y en ait deux. */
  provider: z.enum(SOURCE_PROVIDER_KINDS),
  /** GitHub : l'installation de l'App qui ouvre le dépôt. Rien chez Gitea. */
  installationId: z.number().int().positive().nullable(),
  branch: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((branch) => !/\s|\.\.|^[/-]|[~^:?*[\\]/.test(branch), { message: 'nom de branche invalide' }),
  specPath: repoPathSchema,
  watchPaths: z.array(repoPathSchema).max(50),
  mode: sourceModeSchema,
  /** Où part un nouveau commit : les cibles de la liaison, là où elle tourne, ou nulle part. */
  deployTo: sourceDeployToSchema,
  enabled: z.boolean(),
  /** Les cibles de la liaison — exigées quand un commit part sur elles (`targets`). */
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

/** Une liaison qui déploie « sur ses cibles » doit en avoir au moins une. */
export function sourceTargetsProblem(
  deployTo: SourceDeployTo,
  targets: readonly unknown[],
): string | null {
  return deployTo === 'targets' && targets.length === 0 ? 'au moins une cible' : null;
}

export const applicationSourceCreateSchema = applicationSourceInputSchema.superRefine(
  (input, context) => {
    const problem = sourceTargetsProblem(input.deployTo, input.targets);
    if (problem) context.addIssue({ code: 'custom', path: ['targets'], message: problem });
  },
);

export const applicationSourcePatchSchema = applicationSourceFields
  .omit({ repository: true, installationId: true, provider: true })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'aucun champ à modifier' });
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

/** Les liaisons actives, pour le polling. */
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
    super('cette application suit déjà cette branche de ce dépôt');
    this.name = 'SourceBindingConflictError';
  }
}

export async function createApplicationSource(
  input: ApplicationSourceInput & {
    applicationId: string;
    connectionId: string;
    createdBy: string | null;
    /** Le commit dont l'application vient d'être créée, s'il y a lieu. */
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
        // Une application créée depuis le dépôt porte déjà l'AppSpec de ce
        // commit : il est à la fois le point de départ du polling et celui
        // dont un déploiement à la main construit le code.
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
    if (!row) throw new Error("createApplicationSource : l'insertion n'a rien retourné");
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

    // Changer de branche, c'est repartir de zéro : le prochain passage relit
    // la tête de la nouvelle branche sans rien déployer.
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

/** Ce qu'un passage de polling a appris d'une liaison. */
export async function recordSourceCheck(
  id: string,
  result: {
    /** Le commit désormais traité, s'il a changé. */
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
 * Réserve un commit pour le traiter : ne réussit que si la liaison en est
 * toujours au commit `previous`. Deux passages de polling qui se chevauchent
 * lisent la même nouveauté ; un seul la réserve, un seul déploie. C'est une
 * écriture conditionnelle, pas un verrou : rien à libérer si le worker tombe.
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

// ─── commits en attente de validation ─────────────────────────────────────────

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
 * Range un commit en attente. Un commit plus récent sur la même liaison rend
 * les précédents caducs : on ne valide pas une version qui n'est plus la tête
 * de la branche.
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

/** Les commits en attente des liaisons d'une application, le plus récent d'abord. */
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
 * Tranche un commit en attente. Ne touche qu'une proposition encore
 * `pending` : deux clics simultanés ne déploient pas deux fois.
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
 * Rend caducs les commits en attente d'une liaison — quand un commit plus
 * récent vient d'être déployé, les précédents n'ont plus de sens.
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

/** Le nombre de liaisons, toutes applications confondues. */
/** Les liaisons de l'instance — ou celles d'une connexion. */
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

// ─── le commit de l'application ──────────────────────────────────────────────

/** L'application porte désormais l'AppSpec de ce commit de la liaison. */
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
 * La liaison d'où vient la version actuelle de l'application : celle qui l'a
 * synchronisée en dernier. Un déploiement lancé à la main construit le code de
 * son commit. `null` : l'application ne vient d'aucun dépôt.
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
