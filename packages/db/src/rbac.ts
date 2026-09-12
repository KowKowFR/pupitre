import {
  LOCKED_ROLE,
  PERMISSIONS,
  ROLE_KEY_PATTERN,
  isLockedRole,
  isPermission,
  type Permission,
  type RoleKey,
} from '@pupitre/core';
import { asc, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { permissions, rolePermissions, roles, userRoles } from './schema/rbac.js';
import { users } from './schema/auth.js';

/**
 * Rôles et permissions.
 *
 * L'autorité, à l'exécution, est la table `roles` — pas une constante du code.
 * Un administrateur crée des rôles et ajuste leurs permissions ; seul `admin`
 * est verrouillé, pour qu'on ne puisse pas se retirer les droits nécessaires
 * pour se les rendre.
 */

export type Role = typeof roles.$inferSelect;

/** Rôles et permissions effectives d'un utilisateur, résolus en une requête. */
export type UserGrants = {
  roles: RoleKey[];
  permissions: Permission[];
};

export async function getUserGrants(
  userId: string,
  db: Database = getDb(),
): Promise<UserGrants> {
  const rows = await db
    .select({ roleKey: roles.key, permissionKey: permissions.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(userRoles.userId, userId));

  const roleKeys = new Set<string>();
  const permissionKeys = new Set<string>();
  for (const row of rows) {
    roleKeys.add(row.roleKey);
    if (row.permissionKey) permissionKeys.add(row.permissionKey);
  }

  return {
    roles: [...roleKeys],
    // Une permission retirée du vocabulaire ne doit plus rien accorder, même si
    // une ligne traîne encore en base.
    permissions: [...permissionKeys].filter(isPermission),
  };
}

/** Remplace les rôles d'un utilisateur. `users.role` reflète le rôle principal. */
export async function setUserRoles(
  userId: string,
  roleKeys: RoleKey[],
  db: Database = getDb(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(userRoles).where(eq(userRoles.userId, userId));

    if (roleKeys.length > 0) {
      const rows = await tx.select().from(roles).where(inArray(roles.key, [...roleKeys]));
      if (rows.length !== roleKeys.length) {
        const known = new Set(rows.map((r) => r.key));
        const missing = roleKeys.filter((k) => !known.has(k));
        throw new Error(`rôle(s) inconnu(s) : ${missing.join(', ')}`);
      }
      await tx.insert(userRoles).values(rows.map((r) => ({ userId, roleId: r.id })));
    }

    // Le plugin admin de Better Auth lit `users.role` : on le tient à jour.
    await tx
      .update(users)
      .set({ role: roleKeys[0] ?? null, updatedAt: new Date() })
      .where(eq(users.id, userId));
  });
}

// ─── lecture ──────────────────────────────────────────────────────────────────

export type RoleWithPermissions = Role & {
  permissions: Permission[];
  userCount: number;
};

export async function listRoles(db: Database = getDb()): Promise<Role[]> {
  return db.select().from(roles).orderBy(asc(roles.key));
}

/** Rôles, leurs permissions et le nombre d'utilisateurs qui les portent. */
export async function listRolesWithPermissions(
  db: Database = getDb(),
): Promise<RoleWithPermissions[]> {
  const [all, grants, counts] = await Promise.all([
    db.select().from(roles).orderBy(asc(roles.key)),
    db
      .select({ roleId: rolePermissions.roleId, key: permissions.key })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId)),
    db
      .select({ roleId: userRoles.roleId, value: count() })
      .from(userRoles)
      .groupBy(userRoles.roleId),
  ]);

  const byRole = new Map<string, Permission[]>();
  for (const row of grants) {
    if (!isPermission(row.key)) continue;
    const bucket = byRole.get(row.roleId) ?? [];
    bucket.push(row.key);
    byRole.set(row.roleId, bucket);
  }

  const userCounts = new Map(counts.map((row) => [row.roleId, row.value]));

  return all.map((role) => ({
    ...role,
    permissions: (byRole.get(role.id) ?? []).sort(),
    userCount: userCounts.get(role.id) ?? 0,
  }));
}

export async function getRoleByKey(
  key: string,
  db: Database = getDb(),
): Promise<RoleWithPermissions | null> {
  const all = await listRolesWithPermissions(db);
  return all.find((role) => role.key === key) ?? null;
}

export async function countUsersWithRole(
  roleId: string,
  db: Database = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(userRoles)
    .where(eq(userRoles.roleId, roleId));
  return row?.value ?? 0;
}

// ─── écriture ─────────────────────────────────────────────────────────────────

export const roleKeySchema = z
  .string()
  .min(2)
  .max(48)
  .regex(ROLE_KEY_PATTERN, 'clé en kebab-case : minuscules, chiffres et tirets');

export const permissionListSchema = z
  .array(z.string())
  .max(PERMISSIONS.length)
  .transform((keys) => [...new Set(keys)].filter(isPermission));

export const createRoleSchema = z.object({
  key: roleKeySchema,
  label: z.string().min(2).max(80),
  description: z.string().max(300).optional(),
  permissions: permissionListSchema.default([]),
});

export const updateRoleSchema = z.object({
  label: z.string().min(2).max(80).optional(),
  description: z.string().max(300).nullable().optional(),
  permissions: permissionListSchema.optional(),
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

/** Le rôle demandé est-il modifiable ? Un rôle verrouillé ne l'est pas. */
export class LockedRoleError extends Error {
  constructor(readonly key: string) {
    super(`Le rôle « ${key} » est verrouillé : il ne peut être ni modifié ni supprimé.`);
    this.name = 'LockedRoleError';
  }
}

/** Le rôle est encore porté par des utilisateurs. */
export class RoleInUseError extends Error {
  constructor(
    readonly key: string,
    readonly userCount: number,
  ) {
    super(
      `${userCount} utilisateur(s) portent le rôle « ${key} ». ` +
        'Réattribuez-les avant de le supprimer.',
    );
    this.name = 'RoleInUseError';
  }
}

export async function createRole(
  input: CreateRoleInput,
  db: Database = getDb(),
): Promise<RoleWithPermissions> {
  if (isLockedRole(input.key)) throw new LockedRoleError(input.key);

  return db.transaction(async (tx) => {
    const [role] = await tx
      .insert(roles)
      .values({
        key: input.key,
        label: input.label,
        ...(input.description !== undefined ? { description: input.description } : {}),
        locked: false,
      })
      .returning();

    if (!role) throw new Error("createRole : l'insertion n'a rien retourné");

    // On retourne ce qui a RÉELLEMENT été écrit, pas ce qu'on nous a passé :
    // une clé inconnue du vocabulaire n'est pas persistée, et la réponse ne
    // doit pas prétendre le contraire.
    const granted = await replacePermissions(tx, role.id, input.permissions);

    return { ...role, permissions: granted, userCount: 0 };
  });
}

export async function updateRole(
  key: string,
  patch: UpdateRoleInput,
  db: Database = getDb(),
): Promise<RoleWithPermissions | null> {
  const existing = await getRoleByKey(key, db);
  if (!existing) return null;
  if (existing.locked) throw new LockedRoleError(key);

  return db.transaction(async (tx) => {
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.label !== undefined) values.label = patch.label;
    if (patch.description !== undefined) values.description = patch.description;

    const [role] = await tx
      .update(roles)
      .set(values)
      .where(eq(roles.id, existing.id))
      .returning();

    if (!role) throw new Error("updateRole : la mise à jour n'a rien retourné");

    const granted =
      patch.permissions === undefined
        ? [...existing.permissions].sort()
        : await replacePermissions(tx, role.id, patch.permissions);

    return { ...role, permissions: granted, userCount: existing.userCount };
  });
}

/**
 * Supprime un rôle. Refuse si un utilisateur le porte encore : c'est la même
 * règle que pour une cible qui porte un déploiement vivant.
 */
export async function deleteRole(key: string, db: Database = getDb()): Promise<boolean> {
  const existing = await getRoleByKey(key, db);
  if (!existing) return false;
  if (existing.locked) throw new LockedRoleError(key);

  const userCount = await countUsersWithRole(existing.id, db);
  if (userCount > 0) throw new RoleInUseError(key, userCount);

  await db.delete(roles).where(eq(roles.id, existing.id));
  return true;
}

/**
 * Réécrit l'ensemble des permissions d'un rôle et retourne celles réellement
 * accordées. Une clé absente de la table `permissions` est écartée sans bruit :
 * le vocabulaire est fixé par le code, la base ne fait qu'en refléter l'état.
 */
async function replacePermissions(
  tx: Database,
  roleId: string,
  wanted: readonly string[],
): Promise<Permission[]> {
  await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));

  const known = [...new Set(wanted)].filter(isPermission);
  if (known.length === 0) return [];

  const rows = await tx
    .select({ id: permissions.id, key: permissions.key })
    .from(permissions)
    .where(inArray(permissions.key, known));

  if (rows.length > 0) {
    await tx
      .insert(rolePermissions)
      .values(rows.map((row) => ({ roleId, permissionId: row.id })));
  }

  return rows
    .map((row) => row.key)
    .filter(isPermission)
    .sort();
}

/** Le rôle `admin` détient-il bien la totalité des permissions ? */
export async function assertAdminIntegrity(db: Database = getDb()): Promise<boolean> {
  const admin = await getRoleByKey(LOCKED_ROLE, db);
  return admin !== null && admin.permissions.length === PERMISSIONS.length;
}
