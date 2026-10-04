import {
  LOCKED_ROLE,
  PERMISSIONS,
  ROLE_KEY_PATTERN,
  isLockedRole,
  isPermission,
  type Permission,
  type RoleKey,
} from '@pupitre/core';
import { and, asc, count, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { permissions, rolePermissions, roles, userRoles } from './schema/rbac.js';
import { accounts, users } from './schema/auth.js';

/**
 * Roles and permissions.
 *
 * The authority, at runtime, is the `roles` table — not a constant of the code.
 * An administrator creates roles and adjusts their permissions; only `admin` is
 * locked, so that one cannot remove the rights needed to give them back.
 */

export type Role = typeof roles.$inferSelect;

/** A user's roles and effective permissions, resolved in one query. */
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
    // A permission removed from the vocabulary must no longer grant anything, even
    // if a row still lingers in the database.
    permissions: [...permissionKeys].filter(isPermission),
  };
}

/** Replaces a user's roles. `users.role` reflects the main role. */
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
        throw new Error(`unknown role(s): ${missing.join(', ')}`);
      }
      await tx.insert(userRoles).values(rows.map((r) => ({ userId, roleId: r.id })));
    }

    // Better Auth's admin plugin reads `users.role`: we keep it up to date.
    await tx
      .update(users)
      .set({ role: roleKeys[0] ?? null, updatedAt: new Date() })
      .where(eq(users.id, userId));
  });
}

// ─── reading ──────────────────────────────────────────────────────────────────

export type RoleWithPermissions = Role & {
  permissions: Permission[];
  userCount: number;
};

export async function listRoles(db: Database = getDb()): Promise<Role[]> {
  return db.select().from(roles).orderBy(asc(roles.key));
}

/** Roles, their permissions and the number of users carrying them. */
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

/** What the second factor policy must know about an active account. */
export type TwoFactorExposure = {
  userId: string;
  twoFactorEnabled: boolean;
  /** Without a password, the account only gets in through single sign-on. */
  hasPassword: boolean;
  permissions: Permission[];
};

/**
 * The active accounts, their second factor and their effective permissions:
 * enough to say, before saving it, whom a policy would keep out.
 */
export async function listTwoFactorExposure(db: Database = getDb()): Promise<TwoFactorExposure[]> {
  const [active, grants, passwords] = await Promise.all([
    db
      .select({ id: users.id, twoFactorEnabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.banned, false)),
    db
      .select({ userId: userRoles.userId, key: permissions.key })
      .from(userRoles)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId)),
    db
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(and(eq(accounts.providerId, 'credential'), isNotNull(accounts.password))),
  ]);

  const byUser = new Map<string, Set<Permission>>();
  for (const row of grants) {
    if (!isPermission(row.key)) continue;
    const bucket = byUser.get(row.userId) ?? new Set<Permission>();
    bucket.add(row.key);
    byUser.set(row.userId, bucket);
  }
  const withPassword = new Set(passwords.map((row) => row.userId));

  return active.map((user) => ({
    userId: user.id,
    twoFactorEnabled: user.twoFactorEnabled,
    hasPassword: withPassword.has(user.id),
    permissions: [...(byUser.get(user.id) ?? [])],
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

// ─── writing ──────────────────────────────────────────────────────────────────

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

/** Can the requested role be changed? A locked role cannot. */
export class LockedRoleError extends Error {
  constructor(readonly key: string) {
    super(`The role "${key}" is locked: it can be neither changed nor deleted.`);
    this.name = 'LockedRoleError';
  }
}

/** The role is still carried by users. */
export class RoleInUseError extends Error {
  constructor(
    readonly key: string,
    readonly userCount: number,
  ) {
    super(`${userCount} user(s) carry the role "${key}". ` + 'Reassign them before deleting it.');
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

    if (!role) throw new Error("createRole: the insert returned nothing");

    // We return what was REALLY written, not what we were passed: a key unknown to
    // the vocabulary is not persisted, and the response must not claim otherwise.
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

    if (!role) throw new Error("updateRole: the update returned nothing");

    const granted =
      patch.permissions === undefined
        ? [...existing.permissions].sort()
        : await replacePermissions(tx, role.id, patch.permissions);

    return { ...role, permissions: granted, userCount: existing.userCount };
  });
}

/**
 * Deletes a role. Refuses if a user still carries it: it is the same rule as for
 * a target carrying a live deployment.
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
 * Rewrites a role's whole set of permissions and returns those really granted. A
 * key absent from the `permissions` table is discarded silently: the vocabulary
 * is set by the code, the database only reflects its state.
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

/** Does the `admin` role really hold all the permissions? */
export async function assertAdminIntegrity(db: Database = getDb()): Promise<boolean> {
  const admin = await getRoleByKey(LOCKED_ROLE, db);
  return admin !== null && admin.permissions.length === PERMISSIONS.length;
}
