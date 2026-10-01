import {
  checkableImages,
  imageCheckJobDataSchema,
  judgeImage,
  newerTags,
  parseAppSpec,
  parseVersionTag,
  updateNoticeKey,
  type ImageCheckJobResult,
  type ImageReference,
  type RunningImage,
} from '@pupitre/core';
import { getDriver } from '@pupitre/core/drivers';
import { RegistryError, createRegistryClient } from '@pupitre/core/images';
import { disconnect } from '@pupitre/core/ssh';
import {
  getApplication,
  getTarget,
  listCurrentDeployments,
  listLiveDeployments,
  logAudit,
  markImageNoticesSent,
  pruneImageUpdates,
  recordImageCheck,
  type Deployment,
  type ImageCheckRecord,
} from '@pupitre/db';
import type { Job } from 'bullmq';
import { openDeploymentContext } from '../deploy/context.js';
import { logger } from '../logger.js';

/**
 * Les images des applications déployées, comparées à leurs registres.
 *
 * Pour chaque application en service, sur chaque cible :
 *
 *   1. le driver dit ce qui tourne (`runningImages()`, des digests) ;
 *   2. le registre dit ce que le tag désigne aujourd'hui, et quels tags
 *      existent ;
 *   3. le constat est écrit, et ce qui est **nouveau** — un contenu de tag
 *      jamais annoncé, un tag de la série jamais annoncé — part au journal
 *      d'audit sous `image.update.available`. C'est cette entrée, et elle
 *      seule, qui fait partir les mails et webhooks configurés : la
 *      notification passe par `logAudit()`, comme toutes les autres.
 *
 * Un même registre est interrogé une fois par tag et par passage, quel que soit
 * le nombre d'applications qui l'utilisent. Une application arrêtée n'est pas
 * vérifiée : son dernier constat reste affiché jusqu'à ce qu'elle reparte.
 */

type RegistryAnswer = { digest: string | null; error: string | null };

function cached<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  let entry = cache.get(key);
  if (!entry) {
    entry = load();
    cache.set(key, entry);
  }
  return entry;
}

export async function handleImageCheck(
  job: Job<unknown, ImageCheckJobResult>,
): Promise<ImageCheckJobResult> {
  const data = imageCheckJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, jobName: job.name, applicationId: data.applicationId });

  const registry = createRegistryClient({ timeoutMs: 15_000 });
  const digests = new Map<string, Promise<RegistryAnswer>>();
  const tagLists = new Map<string, Promise<string[]>>();

  const latestDigest = (ref: ImageReference) =>
    cached(digests, `${ref.registry}/${ref.repository}:${ref.tag}`, async () => {
      try {
        return { digest: await registry.manifestDigest(ref), error: null };
      } catch (error) {
        return { digest: null, error: error instanceof RegistryError ? error.code : 'unexpected' };
      }
    });
  const tags = (ref: ImageReference) =>
    cached(tagLists, `${ref.registry}/${ref.repository}`, () =>
      // Une liste de tags qui échoue ne rend pas le constat inconnu : on saura
      // seulement moins de choses.
      registry.listTags(ref).catch(() => []),
    );

  const deployments = (await listCurrentDeployments()).filter(
    (deployment) =>
      (!data.applicationId || deployment.applicationId === data.applicationId) &&
      deployment.stoppedAt === null,
  );

  let outdated = 0;
  let announced = 0;
  for (const deployment of deployments) {
    try {
      const result = await checkDeployment(deployment, latestDigest, tags, data);
      outdated += result.outdated;
      announced += result.announced ? 1 : 0;
    } catch (error) {
      // Une application en échec ne prive pas les suivantes de leur constat.
      log.warn({ err: error, deploymentId: deployment.id }, 'vérification des images impossible');
    }
  }

  if (!data.applicationId) {
    const live = await listLiveDeployments();
    const pruned = await pruneImageUpdates(live);
    if (pruned > 0) log.info({ pruned }, 'constats d’images oubliés');
  }

  log.info({ checked: deployments.length, outdated, announced }, 'images vérifiées');
  return { checked: deployments.length, outdated, announced };
}

async function checkDeployment(
  deployment: Deployment,
  latestDigest: (ref: ImageReference) => Promise<RegistryAnswer>,
  tags: (ref: ImageReference) => Promise<string[]>,
  data: { actorId: string | null; ip: string | null },
): Promise<{ outdated: number; announced: boolean }> {
  const spec = parseAppSpec(deployment.appSpec);
  const images = checkableImages(spec);
  if (images.length === 0) {
    await recordImageCheck(deployment.applicationId, deployment.targetId, []);
    return { outdated: 0, announced: false };
  }

  // Le nom vient de la base : une cible injoignable a toujours un nom, et
  // c'est précisément celle qu'on voudra lire dans l'annonce.
  const targetName = (await getTarget(deployment.targetId))?.name ?? deployment.targetId;

  // Ce qui tourne, d'abord : sans la cible, pas de comparaison possible.
  let running: RunningImage[] | null = null;
  try {
    const opened = await openDeploymentContext(deployment.id, { connect: { retries: 1 } });
    try {
      running = await getDriver(deployment.runtime).runningImages(opened.ctx);
    } finally {
      await disconnect(opened.session);
    }
  } catch {
    running = null;
  }

  const records: ImageCheckRecord[] = [];
  for (const { service, image, ref } of images) {
    const pinned = ref.digest !== null;
    const runningDigests = running?.find((entry) => entry.service === service)?.digests ?? [];
    const answer = pinned ? { digest: null, error: null } : await latestDigest(ref);
    const versions =
      !pinned && parseVersionTag(ref.tag) ? newerTags(ref.tag, await tags(ref)) : null;

    const status = judgeImage({ pinned, running: runningDigests, latest: answer.digest });
    records.push({
      applicationId: deployment.applicationId,
      targetId: deployment.targetId,
      deploymentId: deployment.id,
      service,
      image,
      status,
      runningDigest: runningDigests[0] ?? null,
      latestDigest: answer.digest,
      newerTag: versions?.sameSeries ?? null,
      nextMajorTag: versions?.nextMajor ?? null,
      error:
        running === null
          ? 'target_unreachable'
          : status === 'unknown'
            ? (answer.error ?? (runningDigests.length === 0 ? 'not_running' : null))
            : null,
    });
  }

  const notified = await recordImageCheck(deployment.applicationId, deployment.targetId, records);

  // Ce qui n'a jamais été annoncé, et seulement cela.
  const fresh = new Map<string, string>();
  for (const record of records) {
    const key = updateNoticeKey({
      status: record.status,
      latestDigest: record.latestDigest,
      sameSeries: record.newerTag,
    });
    if (key && key !== notified.get(record.service)) fresh.set(record.service, key);
  }
  const outdated = records.filter((record) => record.status === 'outdated').length;
  if (fresh.size === 0) return { outdated, announced: false };

  const application = await getApplication(deployment.applicationId);
  await logAudit({
    actorId: data.actorId,
    action: 'image.update.available',
    resourceType: 'application',
    resourceId: deployment.applicationId,
    after: {
      application: spec.name,
      applicationName: application?.name ?? spec.name,
      targetName,
      runtime: deployment.runtime,
      deploymentId: deployment.id,
      images: records
        .filter((record) => fresh.has(record.service))
        .map((record) => ({
          service: record.service,
          image: record.image,
          status: record.status,
          runningDigest: record.runningDigest,
          latestDigest: record.latestDigest,
          newerTag: record.newerTag,
          nextMajorTag: record.nextMajorTag,
        })),
      noticeKey: [...fresh.values()].join(','),
    },
    ip: data.ip,
  });
  await markImageNoticesSent(deployment.applicationId, deployment.targetId, fresh);
  return { outdated, announced: true };
}
