import type { PreflightReport, RuntimesAvailable } from '@tp/core';
import type { TargetLabels } from './schema/infra.js';
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { deployments } from './schema/deployments.js';
import { targets } from './schema/infra.js';

/**
 * Accès aux machines cibles.
 *
 * Règle absolue : `encrypted_credential` ne sort d'ici que par
 * `getTargetSecret()`, réservé au worker. Toutes les autres lectures passent
 * par `publicColumns`, où la colonne n'existe simplement pas — le secret ne
 * peut donc pas fuir par oubli de filtrage.
 */

const publicColumns = {
  id: targets.id,
  name: targets.name,
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
  createdAt: targets.createdAt,
  updatedAt: targets.updatedAt,
} as const;

/** Une cible telle qu'elle peut être exposée par l'API. Sans credential. */
export type PublicTarget = {
  id: string;
  name: string;
  host: string;
  port: number;
  sshUser: string;
  authMethod: 'key' | 'password';
  sudoMethod: 'nopasswd' | 'password';
  labels: TargetLabels;
  /** Plage de ports publiables sur cette machine, bornes comprises. */
  portRangeStart: number;
  portRangeEnd: number;
  runtimesAvailable: RuntimesAvailable;
  preflightReport: PreflightReport | null;
  lastPreflightAt: Date | null;
  status: 'unknown' | 'ok' | 'degraded' | 'unreachable';
  createdAt: Date;
  updatedAt: Date;
};

/** Un port publiable : au-dessus des ports réservés, sous la limite TCP. */
const portNumberSchema = z.number().int().min(1024).max(65_535);

export const labelsSchema = z.record(
  z.string().min(1).max(60),
  z.string().min(1).max(200),
);

const targetFieldsSchema = z.object({
  name: z.string().min(2).max(80),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  sshUser: z.string().min(1).max(64),
  authMethod: z.enum(['key', 'password']),
  /** Clé privée ou mot de passe. Chiffré avant insertion, jamais relu par l'API. */
  credential: z.string().min(1).max(32_768),
  sudoMethod: z.enum(['nopasswd', 'password']).default('nopasswd'),
  labels: labelsSchema.default({}),
  /**
   * Plage de ports publiables. Défaut : la plage `nodePort` de Kubernetes,
   * inoccupée sur une machine standard. Les ports réservés (< 1024) sont
   * exclus : y publier une application exigerait root pour rien.
   */
  portRangeStart: portNumberSchema.default(30_000),
  portRangeEnd: portNumberSchema.default(32_767),
});

export const createTargetSchema = targetFieldsSchema.refine(
  (input) => input.portRangeStart <= input.portRangeEnd,
  {
    message: 'La borne basse de la plage de ports doit précéder la borne haute',
    path: ['portRangeStart'],
  },
);

/**
 * Le patch est partiel : impossible de valider `start <= end` sans relire ce
 * qui est déjà en base. Le contrôle est fait par l'appelant, qui a les deux
 * valeurs — et par la contrainte `targets_port_range_check`, qui a le dernier
 * mot quoi qu'il arrive.
 */
export const updateTargetSchema = targetFieldsSchema
  .partial()
  // Un `credential` absent laisse celui déjà en base : le formulaire d'édition
  // n'a jamais besoin de le renvoyer.
  .extend({ credential: z.string().min(1).max(32_768).optional() });

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
 * Lecture du secret chiffré. **Worker uniquement.**
 * Aucune route HTTP ne doit appeler cette fonction.
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

  if (!row) throw new Error("createTarget : l'insertion n'a retourné aucune ligne");
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

  const [row] = await db
    .update(targets)
    .set(values)
    .where(eq(targets.id, id))
    .returning(publicColumns);

  return row ?? null;
}

export async function deleteTarget(id: string, db: Database = getDb()): Promise<boolean> {
  const [row] = await db.delete(targets).where(eq(targets.id, id)).returning({ id: targets.id });
  return row !== undefined;
}

/** Statuts qui interdisent la suppression d'une cible. */
const LIVE_DEPLOYMENT_STATUSES = ['pending', 'running', 'success'] as const;

/** Déploiements encore vivants sur la cible. */
export async function countLiveDeployments(
  targetId: string,
  db: Database = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(deployments)
    .where(
      and(
        eq(deployments.targetId, targetId),
        inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
      ),
    );
  return row?.value ?? 0;
}

/** Un nom ou un triplet (host, port, user) déjà pris renvoie `true`. */
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

/** Écrit le résultat d'un preflight. Appelé par le worker. */
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
