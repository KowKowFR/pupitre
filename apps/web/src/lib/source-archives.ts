import 'server-only';
import { createHash } from 'node:crypto';
import {
  SOURCE_ARCHIVE_CHUNK_BYTES,
  SOURCE_ARCHIVE_INSPECT_JOB,
  SOURCE_UPLOAD_MAX_BYTES,
  checkDockerfiles,
  expectedDockerfiles,
  sniffArchiveFormat,
  sourceArchiveInspectJobDataSchema,
  sourceArchiveLabel,
  type AppSpec,
} from '@pupitre/core';
import {
  appendSourceArchiveChunk,
  createSourceArchive,
  deleteSourceArchive,
  finishSourceArchiveUpload,
  getCurrentSourceArchive,
  listApplicationSources,
  type SourceArchive,
  type SourceArchiveView,
} from '@pupitre/db';
import { archives as messages } from '@/i18n/messages/archives';
import { errors } from '@/i18n/messages/errors';
import { HttpError, msg } from './errors';
import { getSupervisionQueue } from './supervision-queue';

/**
 * An application's uploaded code, panel side: receiving the archive, telling the
 * worker to read it, and choosing the one a deployment builds.
 *
 * The panel does not judge the archive — it only recognizes its format from the
 * first bytes and stores it. The long reading is the worker's business
 * (`source:archive-inspect`): a route decompresses nothing.
 */

/** An archive as the routes return it: never its bytes. */
export function archiveJson(archive: SourceArchive | SourceArchiveView) {
  return {
    id: archive.id,
    applicationId: archive.applicationId,
    name: archive.name,
    format: archive.format,
    status: archive.status,
    uploadedBytes: archive.uploadedBytes,
    sha256: archive.sha256,
    archiveBytes: archive.archiveBytes,
    report: archive.report,
    rejection: archive.rejection,
    rejectionDetail: archive.rejectionDetail,
    uploadedBy: archive.uploadedBy,
    uploadedByName: 'uploadedByName' in archive ? archive.uploadedByName : null,
    createdAt: archive.createdAt.toISOString(),
    inspectedAt: archive.inspectedAt?.toISOString() ?? null,
  };
}

const tooLarge = () =>
  new HttpError(
    413,
    'payload_too_large',
    msg(errors, 'payload_too_large', { max: SOURCE_UPLOAD_MAX_BYTES }),
  );

/** Reads the stream up to at least `need` bytes (or its end), to recognize its format. */
async function readHead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  need: number,
): Promise<{ head: Buffer; done: boolean }> {
  const parts: Buffer[] = [];
  let length = 0;
  while (length < need) {
    const { done, value } = await reader.read();
    if (done) return { head: Buffer.concat(parts), done: true };
    parts.push(Buffer.from(value));
    length += value.byteLength;
  }
  return { head: Buffer.concat(parts), done: false };
}

/**
 * Receives the request's body — the archive itself — and stores it in the
 * database as it is uploaded, in one-megabyte chunks, with its SHA-256. Refuses
 * as soon as the bound is crossed, without waiting for the transfer's end. An
 * upload that fails leaves nothing behind.
 */
export async function receiveArchive(
  request: Request,
  input: { applicationId: string; name: string | null; uploadedBy: string },
): Promise<SourceArchive> {
  const announced = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(announced) && announced > SOURCE_UPLOAD_MAX_BYTES) throw tooLarge();
  if (!request.body) throw new HttpError(400, 'empty_archive', msg(messages, 'error.empty'));

  const reader = request.body.getReader();
  const { head, done } = await readHead(reader, 512);
  if (head.length === 0) throw new HttpError(400, 'empty_archive', msg(messages, 'error.empty'));
  const format = sniffArchiveFormat(head);
  if (!format) {
    await reader.cancel().catch(() => undefined);
    throw new HttpError(415, 'unsupported_archive', msg(messages, 'error.format'));
  }

  const archive = await createSourceArchive({
    applicationId: input.applicationId,
    name: sourceArchiveLabel(input.name),
    format,
    uploadedBy: input.uploadedBy,
  });

  const hash = createHash('sha256');
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let seq = 0;
  let total = 0;
  const flush = async (final: boolean) => {
    while (pendingBytes >= SOURCE_ARCHIVE_CHUNK_BYTES || (final && pendingBytes > 0)) {
      const all = Buffer.concat(pending);
      const size = Math.min(SOURCE_ARCHIVE_CHUNK_BYTES, all.length);
      await appendSourceArchiveChunk(archive.id, 'upload', seq, all.subarray(0, size));
      seq += 1;
      pending = all.length > size ? [all.subarray(size)] : [];
      pendingBytes = all.length - size;
    }
  };
  const take = async (bytes: Buffer) => {
    total += bytes.length;
    if (total > SOURCE_UPLOAD_MAX_BYTES) throw tooLarge();
    hash.update(bytes);
    pending.push(bytes);
    pendingBytes += bytes.length;
    await flush(false);
  };

  try {
    await take(head);
    if (!done) {
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        await take(Buffer.from(value));
      }
    }
    await flush(true);
    return await finishSourceArchiveUpload(archive.id, {
      bytes: total,
      sha256: hash.digest('hex'),
    });
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await deleteSourceArchive(archive.id).catch(() => undefined);
    throw error;
  }
}

export async function enqueueArchiveInspect(
  archiveId: string,
  actor: { userId: string; ip: string | null },
): Promise<string> {
  const job = await getSupervisionQueue().add(
    SOURCE_ARCHIVE_INSPECT_JOB,
    sourceArchiveInspectJobDataSchema.parse({ archiveId, actorId: actor.userId, ip: actor.ip }),
    { attempts: 1 },
  );
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.enqueueFailed'));
  return job.id;
}

/** Does the application follow a repository? Then its code comes from there, not an archive. */
export async function isLinkedToRepository(applicationId: string): Promise<boolean> {
  return (await listApplicationSources(applicationId)).length > 0;
}

/**
 * The code a deployment will build, when it comes from an archive: the
 * application's most recent one. Nothing if no service builds, or if the
 * application follows a repository. Refuses — before queuing anything — a service
 * that would build without code, an archive being read or refused, a missing
 * Dockerfile: better to say it here than at the `build` step.
 */
export async function codeFromArchive(
  applicationId: string,
  spec: AppSpec,
): Promise<{ id: string; name: string; sha256: string } | null> {
  const built = expectedDockerfiles(spec);
  if (built.length === 0) return null;
  if (await isLinkedToRepository(applicationId)) return null;

  const archive = await getCurrentSourceArchive(applicationId);
  if (!archive) {
    throw new HttpError(
      409,
      'source_code_missing',
      msg(messages, 'deploy.none', { service: built[0]!.service }),
    );
  }
  if (archive.status === 'pending') {
    throw new HttpError(
      409,
      'archive_pending',
      msg(messages, 'deploy.pending', { name: archive.name }),
    );
  }
  if (archive.status !== 'ready' || !archive.sha256 || !archive.report) {
    throw new HttpError(
      409,
      'archive_rejected',
      msg(messages, 'deploy.rejected', { name: archive.name }),
    );
  }
  const missing = checkDockerfiles(spec, archive.report.dockerfiles).find(
    (check) => check.status === 'missing',
  );
  if (missing) {
    throw new HttpError(
      409,
      'archive_dockerfile_missing',
      msg(messages, 'deploy.dockerfile', {
        service: missing.service,
        path: missing.path,
        name: archive.name,
      }),
    );
  }
  return { id: archive.id, name: archive.name, sha256: archive.sha256 };
}
