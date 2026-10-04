import { decrypt, type AppSpec } from '@pupitre/core';
import { connect, type SshSession, type SshTarget } from '@pupitre/core/ssh';
import { applications, eq, getDb, getTargetSecret, listTargets } from '@pupitre/db';

/**
 * What every end-to-end script does before trying anything out: opening a
 * session to a declared target, and having an application in the database for
 * the port reservations.
 *
 * No host key policy: these scripts aim at throwaway test machines, whose key
 * changes at each recreation.
 */

export type OpenedTarget = {
  session: SshSession;
  target: { id: string; name: string; host: string };
};

/** A session to the named target (or the one designated by its identifier). */
export async function openTarget(ref: string): Promise<OpenedTarget> {
  const found = (await listTargets()).find((target) => target.id === ref || target.name === ref);
  if (!found) throw new Error(`target "${ref}" not found`);
  const stored = await getTargetSecret(found.id);
  if (!stored) throw new Error(`target "${ref}" unreadable`);
  const secret = decrypt(stored.encryptedCredential);
  const ssh: SshTarget = {
    host: stored.target.host,
    port: stored.target.port,
    username: stored.target.sshUser,
    sudoMethod: stored.target.sudoMethod,
    credentials:
      stored.target.authMethod === 'key'
        ? { authMethod: 'key', privateKey: secret }
        : { authMethod: 'password', password: secret },
  };
  return { session: await connect(ssh), target: found };
}

/** The test application in the database, created if needed; its identifier. */
export async function ensureApplication(spec: AppSpec): Promise<string> {
  const db = getDb();
  const [existing] = await db.select().from(applications).where(eq(applications.slug, spec.name));
  if (existing) return existing.id;
  const [created] = await db
    .insert(applications)
    .values({ slug: spec.name, name: spec.name, appSpec: spec })
    .returning({ id: applications.id });
  if (!created) throw new Error('the test application was not created');
  return created.id;
}

/** The port range to try out: `DRIVER_PORT_RANGE` (`min-max`), or nothing. */
export function portRangeFromEnv():
  { portRange: { min: number; max: number } } | Record<string, never> {
  const range = process.env.DRIVER_PORT_RANGE;
  if (!range) return {};
  const [min, max] = range.split('-').map(Number);
  return { portRange: { min: min!, max: max! } };
}
