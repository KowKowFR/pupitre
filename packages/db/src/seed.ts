import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  LOCKED_ROLE,
  PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  ROLE_DEFINITIONS,
  SEEDED_ROLES,
  splitPermission,
} from '@pupitre/core';
import { count, eq, inArray, sql } from 'drizzle-orm';
import { closeDb, getDb, type Database } from './client.js';
import { permissions, rolePermissions, roles } from './schema/rbac.js';

/**
 * RBAC seed — replayed at each panel startup.
 *
 * It does three things, and **nothing else**:
 *
 *   1. it installs the permissions vocabulary (always safe: they are code
 *      constants, not operations decisions);
 *   2. it guarantees that `admin` exists and holds all the permissions — it is
 *      the safeguard that prevents locking yourself out of your panel;
 *   3. on an empty database only, it installs `operator` and `viewer` as
 *      starting points.
 *
 * What it **no longer** does: realign the existing roles' permissions. Since the
 * administration screen allows changing them, realigning them would amount to
 * erasing a deliberate choice at the next `docker compose up`.
 */
export type SeedReport = {
  permissions: number;
  rolesCreated: string[];
  adminRealigned: boolean;
  freshInstall: boolean;
};

export async function seedRbac(db: Database = getDb()): Promise<SeedReport> {
  return db.transaction(async (tx) => {
    // 1. Vocabulaire de permissions.
    await tx
      .insert(permissions)
      .values(
        PERMISSIONS.map((key) => ({
          key,
          ...splitPermission(key),
          description: PERMISSION_DESCRIPTIONS[key],
        })),
      )
      .onConflictDoUpdate({
        target: permissions.key,
        set: { description: sql.raw('excluded."description"') },
      });

    const allPermissions = await tx.select().from(permissions);
    const permissionIdByKey = new Map(allPermissions.map((p) => [p.key, p.id]));

    // 2. Are there already roles? An empty database is recognized by that.
    const [existingCount] = await tx.select({ value: count() }).from(roles);
    const freshInstall = (existingCount?.value ?? 0) === 0;

    const existing = await tx
      .select()
      .from(roles)
      .where(inArray(roles.key, [...SEEDED_ROLES]));
    const byKey = new Map(existing.map((role) => [role.key, role]));

    const rolesCreated: string[] = [];

    // On an empty installation: the three starting roles.
    // Afterwards: `admin` alone, and only if it disappeared.
    const toCreate = freshInstall ? SEEDED_ROLES : ([LOCKED_ROLE] as const);

    for (const key of toCreate) {
      if (byKey.has(key)) continue;

      const definition = ROLE_DEFINITIONS[key];
      const [created] = await tx
        .insert(roles)
        .values({
          key,
          label: definition.label,
          description: definition.description,
          locked: key === LOCKED_ROLE,
        })
        .returning();

      if (!created) continue;
      byKey.set(key, created);
      rolesCreated.push(key);

      const wanted = definition.permissions
        .map((permission) => permissionIdByKey.get(permission))
        .filter((id): id is string => id !== undefined);

      if (wanted.length > 0) {
        await tx
          .insert(rolePermissions)
          .values(wanted.map((permissionId) => ({ roleId: created.id, permissionId })))
          .onConflictDoNothing();
      }
    }

    // 3. `admin` always holds everything. A permission added to the vocabulary goes
    //    to it automatically, and nobody can take it away.
    const admin = byKey.get(LOCKED_ROLE);
    let adminRealigned = false;

    if (admin) {
      if (!admin.locked) {
        await tx.update(roles).set({ locked: true }).where(eq(roles.id, admin.id));
      }

      const held = await tx
        .select({ permissionId: rolePermissions.permissionId })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, admin.id));

      if (held.length !== allPermissions.length) {
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, admin.id));
        await tx.insert(rolePermissions).values(
          allPermissions.map((permission) => ({
            roleId: admin.id,
            permissionId: permission.id,
          })),
        );
        adminRealigned = true;
      }
    }

    return {
      permissions: PERMISSIONS.length,
      rolesCreated,
      adminRealigned,
      freshInstall,
    };
  });
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  seedRbac()
    .then(async (result) => {
      const created =
        result.rolesCreated.length > 0
          ? `, roles created: ${result.rolesCreated.join(', ')}`
          : ', no role created';
      const realigned = result.adminRealigned ? ', admin realigned' : '';
      // eslint-disable-next-line no-console
      console.log(
        `[db] seed RBAC : ${result.permissions} permissions${created}${realigned}` +
          (result.freshInstall ? ' (fresh install)' : ''),
      );
      await closeDb();
    })
    .catch(async (error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[db] RBAC seed failed', error);
      await closeDb();
      process.exit(1);
    });
}
