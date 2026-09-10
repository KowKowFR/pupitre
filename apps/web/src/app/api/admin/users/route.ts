import { LOCKED_ROLE, type RoleKey } from '@tp/core';
import {
  asc,
  count,
  eq,
  getDb,
  getRoleByKey,
  getTwoFactorStates,
  getUserGrants,
  logAudit,
  roleKeySchema,
  setUserRoles,
  userRoles,
  users,
  type TwoFactorState,
} from '@tp/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuth } from '@/lib/auth';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  banned: boolean;
  banReason: string | null;
  roles: RoleKey[];
  /** Second facteur : sans lui, réinitialiser serait un bouton actionné à l'aveugle. */
  twoFactor: TwoFactorState;
  createdAt: string;
};

export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'user:read');

  const db = getDb();
  const rows = await db.select().from(users).orderBy(asc(users.createdAt));
  const grants = await Promise.all(rows.map((row) => getUserGrants(row.id, db)));
  const twoFactor = await getTwoFactorStates(db);

  const items: AdminUser[] = rows.map((row, index) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    banned: row.banned,
    banReason: row.banReason,
    roles: grants[index]?.roles ?? [],
    twoFactor: twoFactor.get(row.id) ?? 'none',
    createdAt: row.createdAt.toISOString(),
  }));

  return NextResponse.json({ items, total: items.length });
});

const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().max(200),
  password: z.string().min(12).max(200),
  role: roleKeySchema.default('viewer'),
});

export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'user:manage');
  const input = await readJsonBody(request, createUserSchema);

  const db = getDb();
  const [existing] = await db
    .select({ value: count() })
    .from(users)
    .where(eq(users.email, input.email));
  if ((existing?.value ?? 0) > 0) {
    throw new ConflictError(`Un compte existe déjà pour ${input.email}`);
  }

  if (!(await getRoleByKey(input.role, db))) {
    throw new NotFoundError(`Rôle « ${input.role} » introuvable`);
  }

  // Passe par Better Auth pour que le mot de passe soit haché comme à
  // l'inscription. Son plugin admin ne connaît que son propre vocabulaire de
  // rôles : on crée donc le compte avec le moins privilégié qu'il accepte, puis
  // on pose le rôle réel par notre couche, qui est l'autorité. Sans ce détour,
  // créer un utilisateur avec un rôle personnalisé serait refusé par Better Auth.
  const created = await getAuth().api.createUser({
    body: {
      name: input.name,
      email: input.email,
      password: input.password,
      role: 'viewer',
    },
    // Better Auth revérifie de son côté que l'appelant est administrateur.
    headers: request.headers,
  });

  await setUserRoles(created.user.id, [input.role], db);

  await logAudit({
    actorId: auth.userId,
    action: 'user.created.by_admin',
    resourceType: 'user',
    resourceId: created.user.id,
    after: { email: input.email, name: input.name, role: input.role },
    ip: auth.ip,
  });

  return NextResponse.json(
    {
      id: created.user.id,
      email: created.user.email,
      name: created.user.name,
      roles: [input.role],
    },
    { status: 201 },
  );
});

/** Nombre d'administrateurs actifs — sert à interdire de retirer le dernier. */
export async function countActiveAdmins(excludeUserId?: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ userId: userRoles.userId, banned: users.banned, role: users.role })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId));

  return rows.filter(
    (row) => row.role === LOCKED_ROLE && !row.banned && row.userId !== excludeUserId,
  ).length;
}
