import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { errorMessage, type UiLanguage } from '@pupitre/core';
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
 * Backing up the panel's database: `pg_dump` in custom format (compressed,
 * restorable table by table), encrypted, placed.
 *
 * What it contains: everything Pupitre knows — applications and versions,
 * targets and their SSH keys (encrypted), secrets (encrypted), accounts, log,
 * monitoring, chat. What it does not contain: `MASTER_KEY`, without which
 * neither these secrets nor the backups themselves can be read.
 */

export const PANEL_DUMP_FILE = 'panel.dump.pupb';

/** The `PG*` variables drawn from `DATABASE_URL`: the password does not go through `ps`. */
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

/** Runs a PostgreSQL tool and plugs its output; fails with the end of stderr. */
export function runPgTool(
  command: string,
  args: string[],
  streams: { stdout?: Writable; stdin?: Readable },
  language: UiLanguage,
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
    // A pipe's failure is read at the process's end (`close`). Without a process — a
    // missing binary —, that end may never come: a rejection left without a reader
    // would then bring the whole worker down.
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
    if (!record) throw new Error('the backup row has disappeared');

    // Custom format: already compressed, and pg_restore can extract a single table
    // from it — enough to recover an erased row without replacing everything.
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
    log.info({ bytes: dump.bytes }, 'panel database backed up');
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
    log.error({ err: error }, 'panel backup failed');
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
