import type { PreflightReport, RuntimesAvailable } from '@pupitre/core';
import type { TargetLabels } from './schema/infra.js';
import { count, eq, ne } from 'drizzle-orm';
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
  createdAt: targets.createdAt,
  updatedAt: targets.updatedAt,
} as const;

/** Une cible telle qu'elle peut être exposée par l'API. Sans credential. */
export type PublicTarget = {
  id: string;
  name: string;
  /** `null` quand rien n'a été saisi — jamais `''`. Voir le schéma. */
  description: string | null;
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

/**
 * Longueur maximale d'une description de cible. Exportée parce que le
 * formulaire doit afficher le même compteur que celui qui refusera la saisie —
 * et parce que la contrainte `targets_description_length_check` porte le même
 * nombre. Trois endroits, une seule constante.
 */
export const TARGET_DESCRIPTION_MAX = 280;

/**
 * Nombre maximal d'étiquettes sur une cible.
 *
 * Ce n'est pas une limite technique mais une limite de lisibilité : au-delà
 * d'une douzaine, une ligne de tableau devient un mur de pastilles et
 * l'étiquette cesse de servir à repérer quoi que ce soit.
 */
export const TARGET_LABELS_MAX = 12;

export const labelsSchema = z
  .record(z.string().min(1).max(60), z.string().min(1).max(200))
  .refine((labels) => Object.keys(labels).length <= TARGET_LABELS_MAX, {
    message: `Pas plus de ${TARGET_LABELS_MAX} étiquettes par cible`,
  });

/**
 * Une description absente doit valoir `null`, pas `''`.
 *
 * Le formulaire renvoie toujours la valeur du `<textarea>`, donc `''` quand
 * l'utilisateur efface le texte : sans cette normalisation, effacer une
 * description la remplacerait par une chaîne vide, que chaque écran devrait
 * ensuite penser à traiter comme une absence. On tranche ici, une fois.
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
 * Les champs d'une cible, **sans valeur par défaut**.
 *
 * La séparation n'est pas cosmétique. `z.object({…}).partial()` rend chaque
 * champ facultatif mais **ne retire pas les `.default()`** : le schéma de
 * modification, bâti ainsi, renvoyait pour un corps `{"name":"x"}` un objet
 * contenant aussi `port: 22`, `labels: {}` et la plage de ports par défaut.
 * `updateTarget()` n'ignorant que les clés `undefined`, un PATCH partiel
 * écrasait donc silencieusement les étiquettes et la plage de ports de la
 * cible. Le formulaire du panel renvoyant toujours tous les champs, personne ne
 * l'avait vu ; un appel direct à l'API, lui, en faisait les frais.
 *
 * Les défauts n'appartiennent qu'à la création : c'est le seul moment où
 * « absent » veut dire « prends la valeur usuelle ». En modification, absent
 * veut dire « n'y touche pas », et rien d'autre.
 */
const targetFieldShapes = {
  name: z.string().min(2).max(80),
  description: descriptionSchema,
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  sshUser: z.string().min(1).max(64),
  authMethod: z.enum(['key', 'password']),
  /** Clé privée ou mot de passe. Chiffré avant insertion, jamais relu par l'API. */
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
     * Plage de ports publiables. Défaut : la plage `nodePort` de Kubernetes,
     * inoccupée sur une machine standard. Les ports réservés (< 1024) sont
     * exclus : y publier une application exigerait root pour rien.
     */
    portRangeStart: targetFieldShapes.portRangeStart.default(30_000),
    portRangeEnd: targetFieldShapes.portRangeEnd.default(32_767),
  })
  .refine((input) => input.portRangeStart <= input.portRangeEnd, {
    message: 'La borne basse de la plage de ports doit précéder la borne haute',
    path: ['portRangeStart'],
  });

/**
 * Le patch est partiel : impossible de valider `start <= end` sans relire ce
 * qui est déjà en base. Le contrôle est fait par l'appelant, qui a les deux
 * valeurs — et par la contrainte `targets_port_range_check`, qui a le dernier
 * mot quoi qu'il arrive.
 *
 * Un `credential` absent laisse celui déjà en base : le formulaire d'édition
 * n'a jamais besoin de le renvoyer.
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

/**
 * Ce qui empêche de supprimer une cible, en deux nombres.
 *
 * `deployments.target_id` est en `ON DELETE restrict` : **toute** ligne de
 * déploiement bloque la suppression, y compris un `failed` d'il y a trois
 * semaines ou un `destroyed` dont plus rien ne tourne. Ne compter que les
 * déploiements vivants laissait donc passer la garde applicative, et c'est la
 * contrainte qui refusait ensuite — l'appelant recevait une erreur de base de
 * données en 500 là où il attendait un refus motivé.
 *
 * Les deux nombres sont rendus séparément parce qu'ils appellent deux gestes
 * différents : détruire ce qui tourne, ou purger ce qui n'est plus qu'une
 * trace. Les additionner rendrait le message inutilisable.
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
