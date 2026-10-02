import { decrypt, type AppSpec } from '@pupitre/core';
import { connect, type SshSession, type SshTarget } from '@pupitre/core/ssh';
import { applications, eq, getDb, getTargetSecret, listTargets } from '@pupitre/db';

/**
 * Ce que tout script de bout en bout fait avant d'éprouver quoi que ce soit :
 * ouvrir une session vers une cible déclarée, et avoir une application en base
 * pour les réservations de ports.
 *
 * Aucune politique de clé d'hôte : ces scripts visent des machines de test
 * jetables, dont la clé change à chaque recréation.
 */

export type OpenedTarget = {
  session: SshSession;
  target: { id: string; name: string; host: string };
};

/** Une session vers la cible nommée (ou désignée par son identifiant). */
export async function openTarget(ref: string): Promise<OpenedTarget> {
  const found = (await listTargets()).find((target) => target.id === ref || target.name === ref);
  if (!found) throw new Error(`cible « ${ref} » introuvable`);
  const stored = await getTargetSecret(found.id);
  if (!stored) throw new Error(`cible « ${ref} » illisible`);
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

/** L'application de test en base, créée au besoin ; son identifiant. */
export async function ensureApplication(spec: AppSpec): Promise<string> {
  const db = getDb();
  const [existing] = await db.select().from(applications).where(eq(applications.slug, spec.name));
  if (existing) return existing.id;
  const [created] = await db
    .insert(applications)
    .values({ slug: spec.name, name: spec.name, appSpec: spec })
    .returning({ id: applications.id });
  if (!created) throw new Error("l'application de test n'a pas été créée");
  return created.id;
}

/** La plage de ports à éprouver : `DRIVER_PORT_RANGE` (`min-max`), ou rien. */
export function portRangeFromEnv():
  { portRange: { min: number; max: number } } | Record<string, never> {
  const range = process.env.DRIVER_PORT_RANGE;
  if (!range) return {};
  const [min, max] = range.split('-').map(Number);
  return { portRange: { min: min!, max: max! } };
}
