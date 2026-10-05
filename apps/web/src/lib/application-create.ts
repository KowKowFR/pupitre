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
import { assertNameFree } from './application-name';
import { ConflictError, msg } from './errors';

/**
 * Creating an application: the same sequence of gestures whatever the origin of
 * its AppSpec — form, AI, Compose import, catalog or GitHub repository. The free
 * name, the declared secrets given a value, and the log that says where it comes
 * from.
 */
export async function createApplicationFromSpec(input: {
  appSpec: AppSpec;
  description?: string;
  generation?: GenerationOrigin;
  /** Where the AppSpec comes from, for the log; `generation` says AI by itself. */
  origin: 'manual' | 'compose' | 'repository';
  /** What the log keeps on top of the origin (the repository, the branch…). */
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
  await assertNameFree(input.appSpec.name);

  const application = await createApplication({
    appSpec: input.appSpec,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.generation !== undefined ? { generation: input.generation } : {}),
    ownerId: input.actorId,
  });

  // The declared secrets receive a generated value right away: a deployment must
  // never fail because nobody thought of filling them in. A value from outside is
  // set afterwards, through PUT.
  const generated = await syncApplicationSecrets(application.id, input.appSpec);
  // Then the chosen ones replace the randomly drawn values.
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
            // A spec accepted as is and a reworked spec do not tell the same story: the log
            // must tell them apart.
            edited: JSON.stringify(input.generation.appSpec) !== JSON.stringify(input.appSpec),
          }
        : { origin: input.origin, ...(input.originDetail ?? {}) }),
      // The names, never the values.
      secretsGenerated: generated.filter((name) => !(name in input.secrets)),
      secretsProvided: Object.keys(input.secrets),
    },
    ip: input.ip,
  });

  return application;
}
