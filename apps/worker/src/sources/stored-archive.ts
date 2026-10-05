import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SOURCE_ARCHIVE_CHUNK_BYTES } from '@pupitre/core';
import {
  appendSourceArchiveChunk,
  clearSourceArchiveChunks,
  readSourceArchiveChunks,
  type SourceArchiveChunkKind,
} from '@pupitre/db';

/**
 * An uploaded archive's bytes, between the database and the worker's disk. One
 * chunk at a time both ways: the archive never fits in memory, whatever its
 * size.
 */

/** Writes into `path` the chunks stored in the database; returns the number of bytes. */
export async function exportArchiveChunks(
  archiveId: string,
  kind: SourceArchiveChunkKind,
  path: string,
): Promise<number> {
  let bytes = 0;
  const counted = async function* () {
    for await (const chunk of readSourceArchiveChunks(archiveId, kind)) {
      bytes += chunk.length;
      yield chunk;
    }
  };
  await pipeline(Readable.from(counted()), createWriteStream(path, { mode: 0o600 }));
  return bytes;
}

/** Stores in the database, in chunks, the `path` file — in place of what was there. */
export async function importArchiveChunks(
  archiveId: string,
  kind: SourceArchiveChunkKind,
  path: string,
): Promise<number> {
  await clearSourceArchiveChunks(archiveId, kind);
  let seq = 0;
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: SOURCE_ARCHIVE_CHUNK_BYTES })) {
    const data = chunk as Buffer;
    await appendSourceArchiveChunk(archiveId, kind, seq, data);
    seq += 1;
    bytes += data.length;
  }
  return bytes;
}
