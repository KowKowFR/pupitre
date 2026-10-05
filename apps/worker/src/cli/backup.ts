/* eslint-disable no-console -- a command-line tool speaks on the console */
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  MANIFEST_FILE,
  backupManifestSchema,
  createDecryptStream,
  decryptBuffer,
  openBackupStore,
} from '@pupitre/core/backup';
import { closeDb, resolveBackupDestination } from '@pupitre/db';
import { env } from '../env.js';
import { PANEL_DUMP_FILE, runPgTool } from '../backup/panel.js';

/** The CLI speaks English, like its usage lines: it runs in a terminal, before any panel. */
const CLI_LANGUAGE = 'en' as const;

/**
 * Disaster recovery gestures, outside the panel.
 *
 *   backup decrypt <file.pupb> <output>
 *       Decrypts a backup file. The same MASTER_KEY is needed.
 *
 *   backup list
 *       The panel backups present on the configured destination.
 *
 *   backup restore-panel <file.pupb | folder> --yes
 *       Replaces the panel's database with a backup: a file downloaded by hand
 *       from the NAS or the bucket, or a folder (`panel/…`) read on the
 *       configured destination.
 *
 * In Docker: `docker compose run --rm worker backup <command>`, panel and worker
 * stopped for a restore — one does not replace a database under the feet of
 * those writing it.
 */

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

async function activeStore() {
  const resolved = await resolveBackupDestination();
  if (!resolved) {
    throw new Error(
      'no destination configured in this database — download the panel.dump.pupb file ' +
        'from the NAS or the bucket, and pass its path.',
    );
  }
  return openBackupStore(resolved.destination, CLI_LANGUAGE);
}

async function list(): Promise<void> {
  const store = await activeStore();
  try {
    const objects = await store.list('panel/');
    const folders = [
      ...new Set(
        objects
          .filter((object) => object.key.endsWith(`/${PANEL_DUMP_FILE}`))
          .map((object) => object.key.slice(0, -(PANEL_DUMP_FILE.length + 1))),
      ),
    ].sort();
    if (folders.length === 0) console.log('no panel backup on the destination');
    for (const folder of folders) console.log(folder);
  } finally {
    await store.close();
  }
}

async function restorePanel(source: string): Promise<void> {
  let encrypted: Readable;
  let close = async () => {};
  if (existsSync(source)) {
    encrypted = createReadStream(source);
  } else {
    const store = await activeStore();
    close = () => store.close();
    const folder = source.replace(/\/+$/, '').replace(new RegExp(`/${PANEL_DUMP_FILE}$`), '');
    const manifest = backupManifestSchema.parse(
      JSON.parse(
        (
          await decryptBuffer(
            await readStream(await store.get(`${folder}/${MANIFEST_FILE}`)),
            undefined,
            CLI_LANGUAGE,
          )
        ).toString(),
      ),
    );
    if (manifest.kind !== 'panel') throw new Error(`"${folder}" is not a panel backup`);
    console.log(`backup from ${manifest.createdAt}`);
    encrypted = await store.get(`${folder}/${PANEL_DUMP_FILE}`);
  }

  try {
    const plain = new PassThrough();
    const decrypting = pipeline(encrypted, createDecryptStream(undefined, CLI_LANGUAGE), plain);
    await Promise.all([
      decrypting,
      runPgTool(
        env.PG_RESTORE_PATH,
        [
          '--clean',
          '--if-exists',
          '--no-owner',
          '--no-privileges',
          `--dbname=${new URL(env.DATABASE_URL).pathname.replace(/^\//, '')}`,
        ],
        { stdin: plain },
        CLI_LANGUAGE,
      ),
    ]);
    console.log('panel database restored — restart the panel and the worker');
  } finally {
    await close();
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'decrypt': {
      const [input, output] = args;
      if (!input || !output) throw new Error('usage: backup decrypt <file.pupb> <output>');
      await pipeline(
        createReadStream(input),
        createDecryptStream(undefined, CLI_LANGUAGE),
        createWriteStream(output),
      );
      console.log(`decrypted: ${output}`);
      return;
    }
    case 'list':
      return list();
    case 'restore-panel': {
      const source = args.find((arg) => !arg.startsWith('--'));
      if (!source) throw new Error('usage: backup restore-panel <file.pupb | folder> --yes');
      if (!args.includes('--yes')) {
        throw new Error(
          'the restore replaces the WHOLE panel database. Stop the panel and the worker, ' +
            'then run again with --yes.',
        );
      }
      return restorePanel(source);
    }
    default:
      console.log(
        'usage: backup decrypt <file> <output> | backup list | backup restore-panel <source> --yes',
      );
      process.exitCode = command ? 1 : 0;
  }
}

main()
  .catch((error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => undefined));
