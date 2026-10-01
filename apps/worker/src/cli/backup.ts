/* eslint-disable no-console -- un outil en ligne de commande parle sur la console */
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

/**
 * Les gestes de reprise après sinistre, hors du panel.
 *
 *   backup decrypt <fichier.pupb> <sortie>
 *       Déchiffre un fichier de sauvegarde. Il faut la même MASTER_KEY.
 *
 *   backup list
 *       Les sauvegardes du panel présentes sur la destination configurée.
 *
 *   backup restore-panel <fichier.pupb | dossier> --yes
 *       Remplace la base du panel par une sauvegarde : un fichier téléchargé
 *       à la main depuis le NAS ou le bucket, ou un dossier (`panel/…`) lu sur
 *       la destination configurée.
 *
 * Dans Docker : `docker compose run --rm worker backup <commande>`, panel et
 * worker arrêtés pour une restauration — on ne remplace pas une base sous les
 * pieds de ceux qui l'écrivent.
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
      'aucune destination configurée dans cette base — téléchargez le fichier panel.dump.pupb ' +
        'depuis le NAS ou le bucket, et passez son chemin.',
    );
  }
  return openBackupStore(resolved.destination);
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
    if (folders.length === 0) console.log('aucune sauvegarde du panel sur la destination');
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
          await decryptBuffer(await readStream(await store.get(`${folder}/${MANIFEST_FILE}`)))
        ).toString(),
      ),
    );
    if (manifest.kind !== 'panel')
      throw new Error(`« ${folder} » n'est pas une sauvegarde du panel`);
    console.log(`sauvegarde du ${manifest.createdAt}`);
    encrypted = await store.get(`${folder}/${PANEL_DUMP_FILE}`);
  }

  try {
    const plain = new PassThrough();
    const decrypting = pipeline(encrypted, createDecryptStream(), plain);
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
      ),
    ]);
    console.log('base du panel restaurée — redémarrez le panel et le worker');
  } finally {
    await close();
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'decrypt': {
      const [input, output] = args;
      if (!input || !output) throw new Error('usage : backup decrypt <fichier.pupb> <sortie>');
      await pipeline(createReadStream(input), createDecryptStream(), createWriteStream(output));
      console.log(`déchiffré : ${output}`);
      return;
    }
    case 'list':
      return list();
    case 'restore-panel': {
      const source = args.find((arg) => !arg.startsWith('--'));
      if (!source) throw new Error('usage : backup restore-panel <fichier.pupb | dossier> --yes');
      if (!args.includes('--yes')) {
        throw new Error(
          'la restauration remplace TOUTE la base du panel. Arrêtez le panel et le worker, ' +
            'puis relancez avec --yes.',
        );
      }
      return restorePanel(source);
    }
    default:
      console.log(
        'usage : backup decrypt <fichier> <sortie> | backup list | backup restore-panel <source> --yes',
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
