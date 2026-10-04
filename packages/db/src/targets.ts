import { invalid } from '@pupitre/core';
import type { PreflightReport, RuntimesAvailable } from '@pupitre/core';
import type { TargetLabels } from './schema/infra.js';
import { and, count, eq, isNull, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { deployments } from './schema/deployments.js';
import { targets } from './schema/infra.js';

/**
 * Access to target machines.
 *
 * Absolute rule: `encrypted_credential` only leaves here through
 * `getTargetSecret()`, reserved to the worker. Every other read goes through
 * `publicColumns`, where the column simply does not exist — the secret therefore
 * cannot leak by a forgotten filter.
 */

const publicColumns = {
  id: targets.id,
  name: targets.name,
  description: targets.description,
  host: targets.host,
  port: targets.port,
  sshUser: targets.sshUser,
  authMethod: targets.authMethod,
  sudoMethod: targets.sudoMethod,
  labels: targets.labels,
  portRangeStart: targets.portRangeStart,
  portRangeEnd: targets.portRangeEnd,
  runtimesAvailable: targets.runtimesAvailable,
  preflightReport: targets.preflightReport,
  lastPreflightAt: targets.lastPreflightAt,
  status: targets.status,
  hostKeyFingerprint: targets.hostKeyFingerprint,
  hostKeyRecordedAt: targets.hostKeyRecordedAt,
  hostKeyPending: targets.hostKeyPending,
  hostKeyPendingAt: targets.hostKeyPendingAt,
  createdAt: targets.createdAt,
  updatedAt: targets.updatedAt,
} as const;

/** A target as it can be exposed by the API. Without credential. */
export type PublicTarget = {
  id: string;
  name: string;
  /** `null` when nothing was entered — never `''`. See the schema. */
  description: string | null;
  host: string;
  port: number;
  sshUser: string;
  authMethod: 'key' | 'password';
  sudoMethod: 'nopasswd' | 'password';
  labels: TargetLabels;
  /** Range of ports publishable on this machine, bounds included. */
  portRangeStart: number;
  portRangeEnd: number;
  runtimesAvailable: RuntimesAvailable;
  preflightReport: PreflightReport | null;
  lastPreflightAt: Date | null;
  status: 'unknown' | 'ok' | 'degraded' | 'unreachable';
  /** The fingerprint of the recorded host key — `null` before the first contact. */
  hostKeyFingerprint: string | null;
  hostKeyRecordedAt: Date | null;
  /** Another key presented since, waiting for a decision. */
  hostKeyPending: string | null;
  hostKeyPendingAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** A publishable port: above the reserved ports, under the TCP limit. */
const portNumberSchema = z.number().int().min(1024).max(65_535);

/**
 * Maximum length of a target description. Exported because the form must show
 * the same counter as the one that will refuse the input — and because the
 * `targets_description_length_check` constraint carries the same number. Three
 * places, a single constant.
 */
export const TARGET_DESCRIPTION_MAX = 280;

/**
 * Maximum number of labels on a target.
 *
 * It is not a technical limit but a readability one: beyond a dozen, a table row
 * becomes a wall of badges and the label stops helping to spot anything.
 */
export const TARGET_LABELS_MAX = 12;

export const labelsSchema = z
  .record(z.string().min(1).max(60), z.string().min(1).max(200))
  .refine(
    (labels) => Object.keys(labels).length <= TARGET_LABELS_MAX,
    invalid('targets.tooManyLabels', { max: TARGET_LABELS_MAX }),
  );

/**
 * A missing description must be `null`, not `''`.
 *
 * The form always sends the `<textarea>`'s value, hence `''` when the user
 * erases the text: without this normalization, erasing a description would
 * replace it with an empty string, which each screen would then have to
 * remember to treat as absent. We decide here, once.
 */
const descriptionSchema = z
  .string()
  .max(TARGET_DESCRIPTION_MAX)
  .nullable()
  .transform((value) => {
    const trimmed = value?.trim() ?? '';
    return trimmed.length === 0 ? null : trimmed;
  });

/**
 * A target's fields, **without default values**.
 *
 * The split is not cosmetic. `z.object({…}).partial()` makes each field optional
 * but **does not remove the `.default()`s**: the update schema, built that way,
 * returned for a `{"name":"x"}` body an object also containing `port: 22`,
 * `labels: {}` and the default port range. `updateTarget()` only ignoring
 * `undefined` keys, a partial PATCH therefore silently overwrote the target's
 * labels and port range. The panel's form always sending every field, nobody
 * had noticed; a direct API call paid the price.
 *
 * Defaults only belong to creation: it is the only moment when "absent" means
 * "take the usual value". On update, absent means "leave it alone", and nothing
 * else.
 */
const targetFieldShapes = {
  name: z.string().min(2).max(80),
  description: descriptionSchema,
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  sshUser: z.string().min(1).max(64),
  authMethod: z.enum(['key', 'password']),
  /** Private key or password. Encrypted before insertion, never read back by the API. */
  credential: z.string().min(1).max(32_768),
  sudoMethod: z.enum(['nopasswd', 'password']),
  labels: labelsSchema,
  portRangeStart: portNumberSchema,
  portRangeEnd: portNumberSchema,
};

export const createTargetSchema = z
  .object({
    ...targetFieldShapes,
    description: targetFieldShapes.description.default(null),
    port: targetFieldShapes.port.default(22),
    sudoMethod: targetFieldShapes.sudoMethod.default('nopasswd'),
    labels: targetFieldShapes.labels.default({}),
    /**
     * Range of publishable ports. Default: Kubernetes's `nodePort` range, unused on
     * a standard machine. Reserved ports (< 1024) are excluded: publishing an
     * application there would require root for nothing.
     */
    portRangeStart: targetFieldShapes.portRangeStart.default(30_000),
    portRangeEnd: targetFieldShapes.portRangeEnd.default(32_767),
  })
  .refine((input) => input.portRangeStart <= input.portRangeEnd, {
    ...invalid('targets.portRange'),
    path: ['portRangeStart'],
  });

/**
 * The patch is partial: impossible to validate `start <= end` without reading
 * what is already in the database. The check is done by the caller, which has
 * both values — and by the `targets_port_range_check` constraint, which has the
 * last word whatever happens.
 *
 * An absent `credential` leaves the one already in the database: the edit form
 * never needs to send it back.
 */
export const updateTargetSchema = z.object(targetFieldShapes).partial();

export type CreateTargetInput = z.infer<typeof createTargetSchema>;
export type UpdateTargetInput = z.infer<typeof updateTargetSchema>;

export async function listTargets(db: Database = getDb()): Promise<PublicTarget[]> {
  return db.select(publicColumns).from(targets).orderBy(targets.name);
}

export async function getTarget(
  id: string,
  db: Database = getDb(),
): Promise<PublicTarget | null> {
  const [row] = await db.select(publicColumns).from(targets).where(eq(targets.id, id));
  return row ?? null;
}

/**
 * Reads the encrypted secret. **Worker only.**
 * No HTTP route must call this function.
 */
export async function getTargetSecret(
  id: string,
  db: Database = getDb(),
): Promise<{ target: PublicTarget; encryptedCredential: string } | null> {
  const [row] = await db.select().from(targets).where(eq(targets.id, id));
  if (!row) return null;

  const { encryptedCredential, ...rest } = row;
  return { target: rest, encryptedCredential };
}

export async function createTarget(
  input: Omit<CreateTargetInput, 'credential'> & { encryptedCredential: string },
  db: Database = getDb(),
): Promise<PublicTarget> {
  const [row] = await db
    .insert(targets)
    .values({
      name: input.name,
      description: input.description,
      host: input.host,
      port: input.port,
      sshUser: input.sshUser,
      authMethod: input.authMethod,
      sudoMethod: input.sudoMethod,
      labels: input.labels,
      portRangeStart: input.portRangeStart,
      portRangeEnd: input.portRangeEnd,
      encryptedCredential: input.encryptedCredential,
    })
    .returning(publicColumns);

  if (!row) throw new Error('createTarget: the insert returned no row');
  return row;
}

export async function updateTarget(
  id: string,
  patch: Omit<UpdateTargetInput, 'credential'> & { encryptedCredential?: string },
  db: Database = getDb(),
): Promise<PublicTarget | null> {
  const values: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of [
    'name',
    'description',
    'host',
    'port',
    'sshUser',
    'authMethod',
    'sudoMethod',
    'labels',
    'portRangeStart',
    'portRangeEnd',
  ] as const) {
    if (patch[key] !== undefined) values[key] = patch[key];
  }
  if (patch.encryptedCredential !== undefined) {
    values.encryptedCredential = patch.encryptedCredential;
  }

  // Another address is another machine: its key is no longer known, and the next
  // connection will record it. Without this, targeting a new machine would be
  // refused as an impersonation.
  if (patch.host !== undefined || patch.port !== undefined) {
    const [current] = await db
      .select({ host: targets.host, port: targets.port })
      .from(targets)
      .where(eq(targets.id, id));
    if (
      current &&
      ((patch.host !== undefined && patch.host !== current.host) ||
        (patch.port !== undefined && patch.port !== current.port))
    ) {
      values.hostKeyFingerprint = null;
      values.hostKeyRecordedAt = null;
      values.hostKeyPending = null;
      values.hostKeyPendingAt = null;
    }
  }

  const [row] = await db
    .update(targets)
    .set(values)
    .where(eq(targets.id, id))
    .returning(publicColumns);

  return row ?? null;
}

// ─── the host key ───────────────────────────────────────────────────────────

/**
 * Records the key of a machine never reached. No effect if a key is already
 * recorded — two simultaneous first connections only record one. `true`: it was
 * just recorded.
 */
export async function recordTargetHostKey(
  id: string,
  fingerprint: string,
  db: Database = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(targets)
    .set({ hostKeyFingerprint: fingerprint, hostKeyRecordedAt: new Date() })
    .where(and(eq(targets.id, id), isNull(targets.hostKeyFingerprint)))
    .returning({ id: targets.id });
  return rows.length > 0;
}

/**
 * Notes the unexpected key a machine just presented. `true` if it is new —
 * another key than the one already noted: that is when we warn, not at each
 * connection attempt that follows.
 */
export async function setTargetHostKeyPending(
  id: string,
  presented: string,
  db: Database = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(targets)
    .set({ hostKeyPending: presented, hostKeyPendingAt: new Date() })
    .where(
      and(
        eq(targets.id, id),
        or(isNull(targets.hostKeyPending), ne(targets.hostKeyPending, presented)),
      ),
    )
    .returning({ id: targets.id });
  return rows.length > 0;
}

/**
 * Decides a pending key: `accept` records it in place of the old one (the
 * machine was reinstalled), `dismiss` discards it and keeps the old one. `null`:
 * nothing was pending.
 */
export async function resolveTargetHostKey(
  id: string,
  decision: 'accept' | 'dismiss',
  db: Database = getDb(),
): Promise<{ previous: string | null; pending: string } | null> {
  const [current] = await db
    .select({ fingerprint: targets.hostKeyFingerprint, pending: targets.hostKeyPending })
    .from(targets)
    .where(eq(targets.id, id));
  if (!current?.pending) return null;
  await db
    .update(targets)
    .set({
      ...(decision === 'accept'
        ? { hostKeyFingerprint: current.pending, hostKeyRecordedAt: new Date() }
        : {}),
      hostKeyPending: null,
      hostKeyPendingAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(targets.id, id), eq(targets.hostKeyPending, current.pending)));
  return { previous: current.fingerprint, pending: current.pending };
}

export async function deleteTarget(id: string, db: Database = getDb()): Promise<boolean> {
  const [row] = await db.delete(targets).where(eq(targets.id, id)).returning({ id: targets.id });
  return row !== undefined;
}

/** Statuses that forbid deleting a target. */
const LIVE_DEPLOYMENT_STATUSES = ['pending', 'running', 'success'] as const;

/**
 * What prevents deleting a target, in two numbers.
 *
 * `deployments.target_id` is `ON DELETE restrict`: **any** deployment row blocks
 * the deletion, including a `failed` from three weeks ago or a `destroyed` where
 * nothing runs anymore. Only counting live deployments therefore let the
 * application guard through, and it was the constraint that refused afterwards —
 * the caller received a database error as a 500 where it expected a reasoned
 * refusal.
 *
 * Both numbers are returned separately because they call for two different
 * gestures: destroying what runs, or purging what is only a trace. Adding them
 * up would make the message unusable.
 */
export async function countDeploymentsOnTarget(
  targetId: string,
  db: Database = getDb(),
): Promise<{ live: number; history: number }> {
  const rows = await db
    .select({ status: deployments.status, value: count() })
    .from(deployments)
    .where(eq(deployments.targetId, targetId))
    .groupBy(deployments.status);

  let live = 0;
  let history = 0;
  for (const row of rows) {
    if ((LIVE_DEPLOYMENT_STATUSES as readonly string[]).includes(row.status)) {
      live += row.value;
    } else {
      history += row.value;
    }
  }
  return { live, history };
}

/** A name or a (host, port, user) triplet already taken returns `true`. */
export async function findConflictingTarget(
  input: { name: string; host: string; port: number; sshUser: string },
  excludeId?: string,
  db: Database = getDb(),
): Promise<'name' | 'endpoint' | null> {
  const rows = await db
    .select({
      id: targets.id,
      name: targets.name,
      host: targets.host,
      port: targets.port,
      sshUser: targets.sshUser,
    })
    .from(targets)
    .where(excludeId ? ne(targets.id, excludeId) : undefined);

  for (const row of rows) {
    if (row.name === input.name) return 'name';
    if (row.host === input.host && row.port === input.port && row.sshUser === input.sshUser) {
      return 'endpoint';
    }
  }
  return null;
}

/** Writes a preflight's result. Called by the worker. */
export async function savePreflightResult(
  targetId: string,
  report: PreflightReport,
  db: Database = getDb(),
): Promise<PublicTarget | null> {
  const [row] = await db
    .update(targets)
    .set({
      runtimesAvailable: report.runtimes,
      preflightReport: report,
      lastPreflightAt: new Date(report.checkedAt),
      status: report.status,
      updatedAt: new Date(),
    })
    .where(eq(targets.id, targetId))
    .returning(publicColumns);

  return row ?? null;
}
