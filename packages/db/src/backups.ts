import { isDeepStrictEqual } from 'node:util';
import {
  DEFAULT_BACKUP_POLICY,
  backupPolicySchema,
  decrypt,
  encrypt,
  parseBackupDestination,
  type BackupDestinationKind,
  type BackupKind,
  type BackupManifest,
  type BackupMode,
  type BackupPolicy,
  type BackupStatus,
  type BackupTrigger,
  type ResolvedBackupDestination,
} from '@pupitre/core';
import { and, desc, eq, inArray, isNull, lt, notExists, sql } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import {
  backupDestinations,
  backupPolicies,
  backups,
  type BackupDestinationRow,
  type BackupRow,
} from './schema/backups.js';
import { applications } from './schema/infra.js';
import { auditLogs } from './schema/ops.js';
import { users } from './schema/auth.js';

/**
 * Les sauvegardes : où, comment, et ce qui a été fait.
 *
 * Règle calquée sur `targets.ts` et `notifications.ts` : `encrypted_secrets`
 * ne sort d'ici que par `resolveBackupDestination()`, réservée au worker.
 * Toute autre lecture rend la destination sans ses secrets.
 */

// ─── destination ─────────────────────────────────────────────────────────────

export type BackupDestinationView = Omit<BackupDestinationRow, 'encryptedSecrets'>;

/** Une configuration telle que JSONB la rend : sans les champs `undefined`. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function view(row: BackupDestinationRow): BackupDestinationView {
  const { encryptedSecrets: _secrets, ...rest } = row;
  return rest;
}

/** La destination en service — la plus récente activée. */
export async function getActiveBackupDestination(
  db: Database = getDb(),
): Promise<BackupDestinationView | null> {
  const [row] = await db
    .select()
    .from(backupDestinations)
    .where(eq(backupDestinations.enabled, true))
    .orderBy(desc(backupDestinations.updatedAt))
    .limit(1);
  return row ? view(row) : null;
}

/**
 * Enregistre la destination. Les secrets absents sont **conservés** — un
 * formulaire qui ne les renvoie pas ne les efface pas —, sauf changement de
 * genre : les clés d'un S3 n'ont aucun sens pour un SFTP.
 *
 * Changer de **lieu** (genre ou configuration) crée une nouvelle ligne et met
 * l'ancienne au repos, sans la supprimer : chaque sauvegarde désigne la ligne
 * où elle a été déposée, et doit pouvoir y être relue — restaurée, effacée —
 * après qu'on a déménagé. Un nom ou une clé changés restent sur la même ligne :
 * le lieu n'a pas bougé. Une ancienne destination sans sauvegarde ne sert plus
 * à rien, elle est supprimée.
 */
export async function saveBackupDestination(
  input: {
    kind: BackupDestinationKind;
    name: string;
    config: Record<string, unknown>;
    secrets: Record<string, string> | null;
  },
  db: Database = getDb(),
): Promise<BackupDestinationView> {
  const [current] = await db
    .select()
    .from(backupDestinations)
    .where(eq(backupDestinations.enabled, true))
    .orderBy(desc(backupDestinations.updatedAt))
    .limit(1);

  const kept =
    current && current.kind === input.kind && current.encryptedSecrets
      ? (JSON.parse(decrypt(current.encryptedSecrets)) as Record<string, string>)
      : {};
  const merged = { ...kept };
  for (const [name, value] of Object.entries(input.secrets ?? {})) {
    if (value === '') delete merged[name];
    else merged[name] = value;
  }

  // Valide l'ensemble avant d'écrire : une destination incomplète n'est pas rangée.
  const resolved = parseBackupDestination(input.kind, input.config, merged);
  const values = {
    kind: input.kind,
    name: input.name,
    config: resolved.config as Record<string, unknown>,
    encryptedSecrets: Object.keys(merged).length > 0 ? encrypt(JSON.stringify(merged)) : null,
    secretFields: Object.keys(merged).sort(),
    enabled: true,
    // Une destination changée n'a encore été testée par personne.
    lastCheckedAt: null,
    lastCheckError: null,
    updatedAt: new Date(),
  };

  const sameLocation =
    current !== undefined &&
    current.kind === input.kind &&
    isDeepStrictEqual(plain(current.config), plain(values.config));

  const [row] =
    current && sameLocation
      ? await db
          .update(backupDestinations)
          .set(values)
          .where(eq(backupDestinations.id, current.id))
          .returning()
      : await db.transaction(async (tx) => {
          await tx
            .update(backupDestinations)
            .set({ enabled: false, updatedAt: new Date() })
            .where(eq(backupDestinations.enabled, true));
          const inserted = await tx.insert(backupDestinations).values(values).returning();
          await tx
            .delete(backupDestinations)
            .where(
              and(
                eq(backupDestinations.enabled, false),
                notExists(
                  tx
                    .select({ id: backups.id })
                    .from(backups)
                    .where(eq(backups.destinationId, backupDestinations.id)),
                ),
              ),
            );
          return inserted;
        });
  if (!row) throw new Error("la destination n'a pas été enregistrée");
  return view(row);
}

/** Pour le worker seul : la destination avec ses secrets déchiffrés. */
export async function resolveBackupDestination(
  id?: string | null,
  db: Database = getDb(),
): Promise<{ id: string; name: string; destination: ResolvedBackupDestination } | null> {
  const [row] = await db
    .select()
    .from(backupDestinations)
    .where(id ? eq(backupDestinations.id, id) : eq(backupDestinations.enabled, true))
    .orderBy(desc(backupDestinations.updatedAt))
    .limit(1);
  if (!row) return null;
  const secrets = row.encryptedSecrets
    ? (JSON.parse(decrypt(row.encryptedSecrets)) as Record<string, string>)
    : {};
  return {
    id: row.id,
    name: row.name,
    destination: parseBackupDestination(row.kind, row.config, secrets),
  };
}

export async function recordBackupDestinationCheck(
  id: string,
  error: string | null,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(backupDestinations)
    .set({ lastCheckedAt: new Date(), lastCheckError: error })
    .where(eq(backupDestinations.id, id));
}

/** Retire la destination : plus rien ne part tant qu'une autre n'est pas réglée. */
export async function disableBackupDestinations(db: Database = getDb()): Promise<number> {
  const rows = await db
    .update(backupDestinations)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(backupDestinations.enabled, true))
    .returning({ id: backupDestinations.id });
  return rows.length;
}

// ─── politique par application ───────────────────────────────────────────────

export async function getBackupPolicy(
  applicationId: string,
  db: Database = getDb(),
): Promise<BackupPolicy & { configured: boolean }> {
  const [row] = await db
    .select()
    .from(backupPolicies)
    .where(eq(backupPolicies.applicationId, applicationId));
  if (!row) return { ...DEFAULT_BACKUP_POLICY, configured: false };
  return {
    ...backupPolicySchema.parse({
      enabled: row.enabled,
      mode: row.mode,
      beforeDeploy: row.beforeDeploy,
      retention: row.retention,
    }),
    configured: true,
  };
}

export async function saveBackupPolicy(
  applicationId: string,
  policy: BackupPolicy,
  userId: string | null,
  db: Database = getDb(),
): Promise<void> {
  const values = {
    enabled: policy.enabled,
    mode: policy.mode,
    beforeDeploy: policy.beforeDeploy,
    retention: policy.retention,
    updatedBy: userId,
    updatedAt: new Date(),
  };
  await db
    .insert(backupPolicies)
    .values({ applicationId, ...values })
    .onConflictDoUpdate({ target: backupPolicies.applicationId, set: values });
}

/** Les applications que la tâche planifiée doit sauvegarder. */
export async function listScheduledBackupPolicies(
  db: Database = getDb(),
): Promise<Array<{ applicationId: string; slug: string; policy: BackupPolicy }>> {
  const rows = await db
    .select({ policy: backupPolicies, slug: applications.slug })
    .from(backupPolicies)
    .innerJoin(applications, eq(applications.id, backupPolicies.applicationId))
    .where(eq(backupPolicies.enabled, true));
  return rows.map(({ policy, slug }) => ({
    applicationId: policy.applicationId,
    slug,
    policy: backupPolicySchema.parse({
      enabled: policy.enabled,
      mode: policy.mode,
      beforeDeploy: policy.beforeDeploy,
      retention: policy.retention,
    }),
  }));
}

/** Les applications dont la politique a déjà été réglée — le choix du premier déploiement n'est plus proposé. */
export async function listBackupPolicyApplicationIds(db: Database = getDb()): Promise<Set<string>> {
  const rows = await db.select({ id: backupPolicies.applicationId }).from(backupPolicies);
  return new Set(rows.map((row) => row.id));
}

/** Toutes les politiques posées, par application — pour la vue d'ensemble des réglages. */
export async function listBackupPolicies(
  db: Database = getDb(),
): Promise<Map<string, BackupPolicy>> {
  const rows = await db.select().from(backupPolicies);
  return new Map(
    rows.map((row) => [
      row.applicationId,
      backupPolicySchema.parse({
        enabled: row.enabled,
        mode: row.mode,
        beforeDeploy: row.beforeDeploy,
        retention: row.retention,
      }),
    ]),
  );
}

/** Combien d'applications sont sauvegardées automatiquement — pour l'écran des réglages. */
export async function countEnabledBackupPolicies(db: Database = getDb()): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(backupPolicies)
    .where(eq(backupPolicies.enabled, true));
  return row?.count ?? 0;
}

// ─── l'historique ────────────────────────────────────────────────────────────

export async function createBackupRecord(
  input: {
    id: string;
    kind: BackupKind;
    applicationId: string | null;
    applicationSlug: string | null;
    targetId: string | null;
    deploymentId: string | null;
    destinationId: string;
    trigger: BackupTrigger;
    mode: BackupMode | null;
    location: string;
    requestedBy: string | null;
  },
  db: Database = getDb(),
): Promise<BackupRow> {
  const [row] = await db.insert(backups).values(input).returning();
  if (!row) throw new Error("la sauvegarde n'a pas été enregistrée");
  return row;
}

export async function finishBackupRecord(
  id: string,
  outcome: {
    status: Exclude<BackupStatus, 'running'>;
    manifest?: BackupManifest | null;
    bytes?: number;
    error?: string | null;
  },
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(backups)
    .set({
      status: outcome.status,
      ...(outcome.manifest !== undefined ? { manifest: outcome.manifest } : {}),
      bytes: outcome.bytes ?? 0,
      error: outcome.error ?? null,
      finishedAt: new Date(),
    })
    .where(eq(backups.id, id));
}

export async function getBackup(id: string, db: Database = getDb()): Promise<BackupRow | null> {
  const [row] = await db.select().from(backups).where(eq(backups.id, id));
  return row ?? null;
}

export async function listBackups(
  filter: { applicationId?: string; kind?: BackupKind; limit?: number },
  db: Database = getDb(),
): Promise<BackupRow[]> {
  return db
    .select()
    .from(backups)
    .where(
      and(
        filter.applicationId ? eq(backups.applicationId, filter.applicationId) : undefined,
        filter.kind ? eq(backups.kind, filter.kind) : undefined,
      ),
    )
    .orderBy(desc(backups.startedAt))
    .limit(filter.limit ?? 50);
}

/**
 * Les sauvegardes réussies d'une application (ou du panel) : ce que la
 * rétention trie. Une sauvegarde ne compte que sur sa destination d'origine —
 * en changer ne doit pas effacer ce qui reste sur l'ancienne.
 */
export async function listRetainedBackups(
  scope: { kind: 'panel' } | { kind: 'application'; applicationId: string },
  destinationId: string,
  db: Database = getDb(),
): Promise<Array<{ id: string; createdAt: Date; location: string }>> {
  const rows = await db
    .select({ id: backups.id, startedAt: backups.startedAt, location: backups.location })
    .from(backups)
    .where(
      and(
        eq(backups.kind, scope.kind),
        scope.kind === 'application' ? eq(backups.applicationId, scope.applicationId) : undefined,
        eq(backups.destinationId, destinationId),
        eq(backups.status, 'success'),
      ),
    );
  return rows.map((row) => ({ id: row.id, createdAt: row.startedAt, location: row.location }));
}

export async function deleteBackupRecords(ids: string[], db: Database = getDb()): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(backups).where(inArray(backups.id, ids));
}

/**
 * Un échec ne laisse rien sur la destination, seulement une ligne d'historique :
 * utile un mois pour comprendre, encombrant ensuite — une destination en panne
 * en écrirait une par nuit. Les réussites suivent la rétention, pas ce délai.
 */
export async function pruneFailedBackups(
  scope: { kind: 'panel' } | { kind: 'application'; applicationId: string },
  before: Date,
  db: Database = getDb(),
): Promise<number> {
  const removed = await db
    .delete(backups)
    .where(
      and(
        eq(backups.kind, scope.kind),
        scope.kind === 'application' ? eq(backups.applicationId, scope.applicationId) : undefined,
        eq(backups.status, 'failed'),
        lt(backups.startedAt, before),
      ),
    )
    .returning({ id: backups.id });
  return removed.length;
}

/** Une sauvegarde ou une restauration est-elle en cours pour cette application ? */
export async function hasRunningBackup(
  applicationId: string | null,
  db: Database = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: backups.id })
    .from(backups)
    .where(
      and(
        applicationId === null
          ? and(eq(backups.kind, 'panel'), isNull(backups.applicationId))
          : eq(backups.applicationId, applicationId),
        eq(backups.status, 'running'),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Au démarrage du worker : ce qui était « en cours » ne l'est plus — le
 * processus qui l'exécutait est mort avec l'ancien worker. Le dire, plutôt
 * que de laisser une sauvegarde tourner pour toujours à l'écran.
 */
export async function failInterruptedBackups(
  startedBefore: Date,
  /** La raison écrite sur chaque sauvegarde, dans la langue de l'instance. */
  reason = 'interrompue : le worker a redémarré pendant la sauvegarde',
  db: Database = getDb(),
): Promise<number> {
  const rows = await db
    .update(backups)
    .set({
      status: 'failed',
      error: reason,
      finishedAt: new Date(),
    })
    .where(and(eq(backups.status, 'running'), lt(backups.startedAt, startedBefore)))
    .returning({ id: backups.id });
  return rows.length;
}

/** La dernière sauvegarde de chaque application — pour la liste et le tableau de bord. */
export async function latestBackupByApplication(
  db: Database = getDb(),
): Promise<Map<string, Pick<BackupRow, 'status' | 'startedAt' | 'finishedAt' | 'error'>>> {
  const rows = await db
    .selectDistinctOn([backups.applicationId], {
      applicationId: backups.applicationId,
      status: backups.status,
      startedAt: backups.startedAt,
      finishedAt: backups.finishedAt,
      error: backups.error,
    })
    .from(backups)
    .where(and(eq(backups.kind, 'application'), sql`${backups.trigger} <> 'pre_restore'`))
    .orderBy(backups.applicationId, desc(backups.startedAt));
  const latest = new Map<
    string,
    Pick<BackupRow, 'status' | 'startedAt' | 'finishedAt' | 'error'>
  >();
  for (const row of rows) {
    if (row.applicationId) latest.set(row.applicationId, row);
  }
  return latest;
}

/**
 * La dernière restauration d'une application, réussie ou non. Elle n'a pas de
 * table : le journal d'audit la porte, avec son déroulé — c'est là qu'on la lit.
 */
export async function lastRestoreOf(
  applicationId: string,
  db: Database = getDb(),
): Promise<{
  ok: boolean;
  at: Date;
  actorName: string | null;
  after: Record<string, unknown>;
} | null> {
  const [row] = await db
    .select({
      action: auditLogs.action,
      createdAt: auditLogs.createdAt,
      after: auditLogs.after,
      actorName: users.name,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(
      and(
        eq(auditLogs.resourceType, 'application'),
        eq(auditLogs.resourceId, applicationId),
        inArray(auditLogs.action, ['backup.restored', 'backup.restore.failed']),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    ok: row.action === 'backup.restored',
    at: row.createdAt,
    actorName: row.actorName,
    after: (row.after ?? {}) as Record<string, unknown>,
  };
}
