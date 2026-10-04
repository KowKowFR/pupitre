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
 * Backups: where, how, and what was done.
 *
 * A rule modeled on `targets.ts` and `notifications.ts`: `encrypted_secrets` only
 * leaves here through `resolveBackupDestination()`, reserved to the worker. Any
 * other read returns the destination without its secrets.
 */

// ─── destination ─────────────────────────────────────────────────────────────

export type BackupDestinationView = Omit<BackupDestinationRow, 'encryptedSecrets'>;

/** A configuration as JSONB returns it: without the `undefined` fields. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function view(row: BackupDestinationRow): BackupDestinationView {
  const { encryptedSecrets: _secrets, ...rest } = row;
  return rest;
}

/** The destination in service — the most recent enabled one. */
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
 * Saves the destination. Absent secrets are **kept** — a form that does not send
 * them back does not erase them —, except on a change of kind: an S3's keys make
 * no sense for an SFTP.
 *
 * Changing **place** (kind or configuration) creates a new row and puts the old
 * one at rest, without deleting it: each backup designates the row where it was
 * placed, and must be readable there — restored, erased — after moving. A
 * changed name or key stay on the same row: the place did not move. An old
 * destination without a backup is no longer useful, it is deleted.
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

  // Validates the whole before writing: an incomplete destination is not stored.
  const resolved = parseBackupDestination(input.kind, input.config, merged);
  const values = {
    kind: input.kind,
    name: input.name,
    config: resolved.config as Record<string, unknown>,
    encryptedSecrets: Object.keys(merged).length > 0 ? encrypt(JSON.stringify(merged)) : null,
    secretFields: Object.keys(merged).sort(),
    enabled: true,
    // A changed destination has not been tested by anybody yet.
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
  if (!row) throw new Error("the destination was not saved");
  return view(row);
}

/** For the worker alone: the destination with its secrets decrypted. */
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

/** Removes the destination: nothing goes out until another is set. */
export async function disableBackupDestinations(db: Database = getDb()): Promise<number> {
  const rows = await db
    .update(backupDestinations)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(backupDestinations.enabled, true))
    .returning({ id: backupDestinations.id });
  return rows.length;
}

// ─── policy per application ──────────────────────────────────────────────────

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

/** The applications the scheduled task must back up. */
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

/**
 * The applications whose policy was already set — the first deployment's choice
 * is no longer offered.
 */
export async function listBackupPolicyApplicationIds(db: Database = getDb()): Promise<Set<string>> {
  const rows = await db.select({ id: backupPolicies.applicationId }).from(backupPolicies);
  return new Set(rows.map((row) => row.id));
}

/** All the policies set, per application — for the settings overview. */
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

/** How many applications are backed up automatically — for the settings screen. */
export async function countEnabledBackupPolicies(db: Database = getDb()): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(backupPolicies)
    .where(eq(backupPolicies.enabled, true));
  return row?.count ?? 0;
}

// ─── the history ─────────────────────────────────────────────────────────────

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
  if (!row) throw new Error("the backup was not saved");
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
 * An application's (or the panel's) successful backups: what retention sorts. A
 * backup only counts on its original destination — changing it must not erase
 * what remains on the old one.
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
 * A failure leaves nothing on the destination, only a history row: useful for a
 * month to understand, cluttering afterwards — a failing destination would write
 * one every night. Successes follow retention, not this delay.
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

/** Is a backup or a restore in progress for this application? */
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
 * At the worker's startup: what was "in progress" no longer is — the process
 * running it died with the old worker. Say so, rather than let a backup run
 * forever on screen.
 */
export async function failInterruptedBackups(
  startedBefore: Date,
  /** The reason written on each backup, in the instance's language. */
  reason = 'interrupted: the worker restarted during the backup',
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

/** Each application's last backup — for the list and the dashboard. */
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
 * An application's last restore, successful or not. It has no table: the audit
 * log carries it, with its course — that is where it is read.
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
