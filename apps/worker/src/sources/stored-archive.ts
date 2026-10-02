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
 * Les octets d'une archive téléversée, entre la base et le disque du worker.
 * Un morceau à la fois dans les deux sens : l'archive ne tient jamais en
 * mémoire, quelle que soit sa taille.
 */

/** Écrit dans `path` les morceaux rangés en base ; rend le nombre d'octets. */
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

/** Range en base, par morceaux, le fichier `path` — à la place de ce qui y était. */
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
