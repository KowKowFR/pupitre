import 'server-only';
import { storedSecretNames, type AppSpec } from '@pupitre/core';
import {
  createApplication,
  getApplicationBySlug,
  logAudit,
  setApplicationSecret,
  syncApplicationSecrets,
  type GenerationOrigin,
} from '@pupitre/db';
import { applications as messages } from '@/i18n/messages/applications';
import { ConflictError, msg } from './errors';

/**
 * Créer une application : la même suite de gestes quelle que soit l'origine de
 * son AppSpec — formulaire, IA, import Compose, catalogue ou dépôt GitHub. Le
 * nom libre, les secrets déclarés pourvus d'une valeur, et le journal qui dit
 * d'où elle vient.
 */
export async function createApplicationFromSpec(input: {
  appSpec: AppSpec;
  description?: string;
  generation?: GenerationOrigin;
  /** D'où vient l'AppSpec, pour le journal ; `generation` dit l'IA à lui seul. */
  origin: 'manual' | 'compose' | 'repository';
  /** Ce que le journal retient en plus de l'origine (le dépôt, la branche…). */
  originDetail?: Record<string, unknown>;
  secrets: Record<string, string>;
  actorId: string;
  ip: string | null;
}) {
  const storable = storedSecretNames(input.appSpec);
  for (const name of Object.keys(input.secrets)) {
    if (!storable.includes(name)) {
      throw new ConflictError(msg(messages, 'error.secretNotDeclared', { name }));
    }
  }

  const existing = await getApplicationBySlug(input.appSpec.name);
  if (existing) {
    throw new ConflictError(msg(messages, 'error.slugTaken', { name: input.appSpec.name }));
  }

  const application = await createApplication({
    appSpec: input.appSpec,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.generation !== undefined ? { generation: input.generation } : {}),
    ownerId: input.actorId,
  });

  // Les secrets déclarés reçoivent tout de suite une valeur générée : un
  // déploiement ne doit jamais échouer parce que personne n'a pensé à les
  // renseigner. Une valeur venue de l'extérieur se pose ensuite, par PUT.
  const generated = await syncApplicationSecrets(application.id, input.appSpec);
  // Puis celles qu'on a choisies remplacent les valeurs tirées au sort.
  for (const [name, value] of Object.entries(input.secrets)) {
    await setApplicationSecret(application.id, name, value, 'provided');
  }

  await logAudit({
    actorId: input.actorId,
    action: 'application.created',
    resourceType: 'application',
    resourceId: application.id,
    after: {
      slug: application.slug,
      version: input.appSpec.version,
      services: input.appSpec.services.map((service) => service.name),
      ...(input.generation
        ? {
            origin: 'ai',
            model: input.generation.model,
            prompt: input.generation.prompt,
            // Une spec acceptée telle quelle et une spec retouchée ne racontent
            // pas la même histoire : le journal doit les distinguer.
            edited: JSON.stringify(input.generation.appSpec) !== JSON.stringify(input.appSpec),
          }
        : { origin: input.origin, ...(input.originDetail ?? {}) }),
      // Les noms, jamais les valeurs.
      secretsGenerated: generated.filter((name) => !(name in input.secrets)),
      secretsProvided: Object.keys(input.secrets),
    },
    ip: input.ip,
  });

  return application;
}
