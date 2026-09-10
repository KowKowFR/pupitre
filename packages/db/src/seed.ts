import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  LOCKED_ROLE,
  PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  ROLE_DEFINITIONS,
  SEEDED_ROLES,
  splitPermission,
} from '@tp/core';
import { count, eq, inArray, sql } from 'drizzle-orm';
import { closeDb, getDb, type Database } from './client.js';
import { permissions, rolePermissions, roles } from './schema/rbac.js';

/**
 * Seed RBAC — rejoué à chaque démarrage du panel.
 *
 * Il fait trois choses, et **rien d'autre** :
 *
 *   1. il installe le vocabulaire de permissions (toujours sûr : ce sont des
 *      constantes du code, pas des décisions d'exploitation) ;
 *   2. il garantit que `admin` existe et détient l'intégralité des permissions —
 *      c'est le garde-fou qui empêche de se verrouiller hors de son panel ;
 *   3. sur une base vierge uniquement, il installe `operator` et `viewer`
 *      comme points de départ.
 *
 * Ce qu'il ne fait **plus** : réaligner les permissions des rôles existants.
 * Depuis que l'écran d'administration permet de les modifier, les réaligner
 * reviendrait à effacer un choix délibéré au prochain `docker compose up`.
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

    // 2. Y a-t-il déjà des rôles ? Une base vierge se reconnaît à ça.
    const [existingCount] = await tx.select({ value: count() }).from(roles);
    const freshInstall = (existingCount?.value ?? 0) === 0;

    const existing = await tx
      .select()
      .from(roles)
      .where(inArray(roles.key, [...SEEDED_ROLES]));
    const byKey = new Map(existing.map((role) => [role.key, role]));

    const rolesCreated: string[] = [];

    // Sur une installation vierge : les trois rôles de départ.
    // Ensuite : `admin` seul, et seulement s'il a disparu.
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

    // 3. `admin` détient toujours tout. Une permission ajoutée au vocabulaire
    //    lui revient d'office, et personne ne peut la lui retirer.
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
          ? `, rôles créés : ${result.rolesCreated.join(', ')}`
          : ', aucun rôle créé';
      const realigned = result.adminRealigned ? ', admin réaligné' : '';
      // eslint-disable-next-line no-console
      console.log(
        `[db] seed RBAC : ${result.permissions} permissions${created}${realigned}` +
          (result.freshInstall ? ' (installation vierge)' : ''),
      );
      await closeDb();
    })
    .catch(async (error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[db] échec du seed RBAC', error);
      await closeDb();
      process.exit(1);
    });
}
