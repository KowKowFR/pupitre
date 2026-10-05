import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DEFAULT_UI_LANGUAGE, errorMessage, type UiLanguage } from '@pupitre/core';
import {
  DEFAULT_BACKUP_RETENTION,
  MANIFEST_FILE,
  backupFolder,
  encryptBuffer,
  type BackupManifest,
  type BackupTrigger,
} from '@pupitre/core/backup';
import {
  createBackupRecord,
  finishBackupRecord,
  getBackup,
  hasRunningBackup,
  logAudit,
} from '@pupitre/db';
import { env } from '../env.js';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { workerSay } from '../messages.js';
import { applyRetention, openStore, storePiece } from './shared.js';

/**
 * Sauvegarder la base du panel : `pg_dump` au format personnalisé (compressé,
 * restaurable table par table), chiffré, déposé.
 *
 * Ce qu'elle contient : tout ce que Pupitre sait — applications et versions,
 * cibles et leurs clés SSH (chiffrées), secrets (chiffrés), comptes, journal,
 * supervision, discussion. Ce qu'elle ne contient pas : `MASTER_KEY`, sans
 * laquelle ni ces secrets ni les sauvegardes elles-mêmes ne se relisent.
 */

export const PANEL_DUMP_FILE = 'panel.dump.pupb';

/** Les variables `PG*` tirées de `DATABASE_URL` : le mot de passe ne passe pas par `ps`. */
function pgEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.replace(/^\//, ''),
    ...(url.searchParams.get('sslmode')
      ? { PGSSLMODE: url.searchParams.get('sslmode') ?? '' }
      : {}),
  };
}

/** Lance un outil PostgreSQL et branche sa sortie ; échoue avec la fin de stderr. */
export function runPgTool(
  command: string,
  args: string[],
  streams: { stdout?: Writable; stdin?: Readable },
  language: UiLanguage = DEFAULT_UI_LANGUAGE,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: pgEnvironment(env.DATABASE_URL),
      stdio: [streams.stdin ? 'pipe' : 'ignore', streams.stdout ? 'pipe' : 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    const flows: Promise<void>[] = [];
    if (streams.stdout && child.stdout) flows.push(pipeline(child.stdout, streams.stdout));
    if (streams.stdin && child.stdin) flows.push(pipeline(streams.stdin, child.stdin));
    // L'échec d'un tube est lu à la fin du processus (`close`). Sans processus
    // — un binaire absent —, cette fin peut ne jamais venir : un rejet resté
    // sans lecteur ferait alors tomber le worker entier.
    for (const flow of flows) flow.catch(() => undefined);
    child.on('error', (error) =>
      reject(
        new Error(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? workerSay(language)('backup.commandMissing', { command })
            : error.message,
        ),
      ),
    );
    child.on('close', (code) => {
      Promise.all(flows).then(() => {
        if (code === 0) resolve();
        else {
          const say = workerSay(language);
          const last = stderr.trim().split('\n').at(-1) ?? say('noDetail');
          reject(
            new Error(say('backup.commandFailed', { command, code: code ?? '?', detail: last })),
          );
        }
      }, reject);
    });
  });
}

export async function backupPanel(request: {
  trigger: BackupTrigger;
  backupId?: string;
  actorId: string | null;
  ip: string | null;
}): Promise<{
  status: 'success' | 'failed' | 'skipped';
  backupId: string | null;
  bytes: number;
  error: string | null;
}> {
  const log = logger.child({ backup: 'panel' });
  const language = await instanceLanguage();
  if (!request.backupId && (await hasRunningBackup(null))) {
    return {
      status: 'skipped',
      backupId: null,
      bytes: 0,
      error: workerSay(language)('backup.panelRunning'),
    };
  }

  let backupId = request.backupId ?? null;
  let opened: Awaited<ReturnType<typeof openStore>> | null = null;
  try {
    opened = await openStore();
    const startedAt = new Date();
    if (!backupId) {
      const id = randomUUID();
      await createBackupRecord({
        id,
        kind: 'panel',
        applicationId: null,
        applicationSlug: null,
        targetId: null,
        deploymentId: null,
        destinationId: opened.id,
        trigger: request.trigger,
        mode: null,
        location: backupFolder('panel', null, id, startedAt),
        requestedBy: request.actorId,
      });
      backupId = id;
    }
    const record = await getBackup(backupId);
    if (!record) throw new Error('la ligne de sauvegarde a disparu');

    // Format personnalisé : déjà compressé, et pg_restore sait en extraire une
    // seule table — de quoi rattraper une ligne effacée sans tout remplacer.
    const dump = await storePiece(
      opened.store,
      `${record.location}/${PANEL_DUMP_FILE}`,
      (sink) =>
        runPgTool(
          env.PG_DUMP_PATH,
          ['--format=custom', '--no-owner', '--no-privileges'],
          { stdout: sink },
          language,
        ),
      { gzip: false },
    );

    const manifest: BackupManifest = {
      format: 1,
      kind: 'panel',
      id: backupId,
      createdAt: startedAt.toISOString(),
      mode: null,
      trigger: request.trigger,
      application: null,
      target: null,
      spec: null,
      pieces: [{ kind: 'database', file: PANEL_DUMP_FILE, ...dump }],
    };
    await opened.store.put(
      `${record.location}/${MANIFEST_FILE}`,
      Readable.from([await encryptBuffer(Buffer.from(JSON.stringify(manifest)))]),
    );
    await finishBackupRecord(backupId, { status: 'success', manifest, bytes: dump.bytes });
    log.info({ bytes: dump.bytes }, 'base du panel sauvegardée');
    await applyRetention(
      opened.store,
      { kind: 'panel' },
      opened.id,
      DEFAULT_BACKUP_RETENTION,
      (line) => log.info(line),
    );
    return { status: 'success', backupId, bytes: dump.bytes, error: null };
  } catch (error) {
    const message = errorMessage(error);
    log.error({ err: error }, 'sauvegarde du panel en échec');
    if (backupId) {
      await finishBackupRecord(backupId, { status: 'failed', error: message });
      const record = await getBackup(backupId);
      if (record && opened)
        await opened.store.removePrefix(`${record.location}/`).catch(() => undefined);
    }
    await logAudit({
      actorId: request.actorId,
      action: 'backup.failed',
      resourceType: 'settings',
      resourceId: null,
      after: { kind: 'panel', backupId, trigger: request.trigger, error: message },
      ip: request.ip,
    });
    return { status: 'failed', backupId, bytes: 0, error: message };
  } finally {
    await opened?.store.close().catch(() => undefined);
  }
}
