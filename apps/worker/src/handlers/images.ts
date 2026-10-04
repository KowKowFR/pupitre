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
 * The deployed applications' images, compared with their registries.
 *
 * For each application in service, on each target:
 *
 *   1. the driver says what runs (`runningImages()`, digests);
 *   2. the registry says what the tag designates today, and which tags exist;
 *   3. the finding is written, and what is **new** — a tag content never
 *      announced, a series tag never announced — goes to the audit log as
 *      `image.update.available`. It is that entry, and it alone, that makes the
 *      configured emails and webhooks go out: the notification goes through
 *      `logAudit()`, like all the others.
 *
 * A given registry is queried once per tag and per pass, whatever the number of
 * applications using it. A stopped application is not checked: its last finding
 * stays shown until it starts again.
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
      // A tags list that fails does not make the finding unknown: we will only know
      // fewer things.
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
      // A failing application does not deprive the following ones of their finding.
      log.warn({ err: error, deploymentId: deployment.id }, 'images check failed');
    }
  }

  if (!data.applicationId) {
    const live = await listLiveDeployments();
    const pruned = await pruneImageUpdates(live);
    if (pruned > 0) log.info({ pruned }, 'image findings forgotten');
  }

  log.info({ checked: deployments.length, outdated, announced }, 'images checked');
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

  // The name comes from the database: an unreachable target always has a name, and
  // it is precisely the one we will want to read in the announcement.
  const targetName = (await getTarget(deployment.targetId))?.name ?? deployment.targetId;

  // What runs, first: without the target, no comparison is possible.
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

  // What was never announced, and only that.
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
