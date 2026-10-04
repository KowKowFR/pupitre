import { randomUUID } from 'node:crypto';
import {
  DEFAULT_BACKUP_RETENTION,
  MANIFEST_FILE,
  backupFolder,
  dumpCommand,
  encryptBuffer,
  pieceFile,
  planBackup,
  type BackupManifest,
  type BackupMode,
  type BackupTrigger,
  type StoredPiece,
} from '@pupitre/core/backup';
import { errorMessage, parseAppSpec } from '@pupitre/core';
import { getDriver } from '@pupitre/core/drivers';
import { disconnect } from '@pupitre/core/ssh';
import { Readable } from 'node:stream';
import {
  createBackupRecord,
  deleteBackupRecords,
  finishBackupRecord,
  getApplication,
  getBackup,
  getBackupPolicy,
  getTarget,
  hasRunningBackup,
  listLiveDeployments,
  logAudit,
} from '@pupitre/db';
import { openDeploymentContext } from '../deploy/context.js';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { formatBytes, workerSay } from '../messages.js';
import { BackupError, applyRetention, openStore, storePiece } from './shared.js';

/**
 * Sauvegarder une application sur une cible.
 *
 * Une seule fonction, quatre appelants : la tâche planifiée (une par
 * application dont la sauvegarde est activée), « Sauvegarder maintenant », la
 * sauvegarde avant déploiement (une étape du pipeline) et la sauvegarde de
 * sûreté qui précède une restauration. Le plan, le chiffrement, la rétention
 * et le compte rendu sont donc les mêmes partout.
 */

export type ApplicationBackupRequest = {
  applicationId: string;
  targetId: string;
  trigger: BackupTrigger;
  /** Le mode de la politique si absent. */
  mode?: BackupMode;
  /** Une ligne déjà créée par la route — l'écran la montre avant même que la tâche parte. */
  backupId?: string;
  actorId: string | null;
  ip: string | null;
  onLog?: (line: string) => void;
};

export type ApplicationBackupResult =
  | { status: 'success'; backupId: string; bytes: number }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; backupId: string | null; error: string };

export async function backupApplication(
  request: ApplicationBackupRequest,
): Promise<ApplicationBackupResult> {
  const log = logger.child({ applicationId: request.applicationId, targetId: request.targetId });
  const onLog = (line: string) => {
    request.onLog?.(line);
    log.info(line);
  };

  const [application, target, policy] = await Promise.all([
    getApplication(request.applicationId),
    getTarget(request.targetId),
    getBackupPolicy(request.applicationId),
  ]);
  const language = await instanceLanguage();
  const say = workerSay(language);
  if (!application) return { status: 'skipped', reason: say('backup.appGone') };

  const [live] = await listLiveDeployments({
    applicationId: request.applicationId,
    targetId: request.targetId,
  });
  const deployment = live?.inService ?? null;
  if (!deployment) {
    if (request.backupId) {
      await finishBackupRecord(request.backupId, {
        status: 'failed',
        error: say('backup.notRunning'),
      });
    }
    return { status: 'skipped', reason: say('backup.notRunning') };
  }

  const spec = parseAppSpec(deployment.appSpec);
  // Arrêtée, l'application n'a plus de base qui réponde : ses volumes sont
  // copiés tels quels — ils sont cohérents, rien n'écrit.
  const stopped = deployment.stoppedAt !== null;
  const mode: BackupMode = stopped ? 'stop' : (request.mode ?? policy.mode);
  const pieces = planBackup(spec, mode);
  if (pieces.length === 0) {
    if (request.backupId) await deleteBackupRecords([request.backupId]);
    return { status: 'skipped', reason: say('backup.nothing') };
  }

  if (!request.backupId && (await hasRunningBackup(request.applicationId))) {
    return { status: 'skipped', reason: say('backup.alreadyRunning') };
  }

  let backupId = request.backupId ?? null;
  let opened: Awaited<ReturnType<typeof openStore>> | null = null;
  let session: Awaited<ReturnType<typeof openDeploymentContext>>['session'] | null = null;
  try {
    opened = await openStore();
    const startedAt = new Date();
    if (!backupId) {
      const id = randomUUID();
      await createBackupRecord({
        id,
        kind: 'application',
        applicationId: application.id,
        applicationSlug: application.slug,
        targetId: request.targetId,
        deploymentId: deployment.id,
        destinationId: opened.id,
        trigger: request.trigger,
        mode,
        location: backupFolder('application', application.slug, id, startedAt),
        requestedBy: request.actorId,
      });
      backupId = id;
    }
    const record = await getBackup(backupId);
    if (!record) throw new BackupError('la ligne de sauvegarde a disparu');
    const location = record.location;

    onLog(
      say('backup.starting', {
        slug: application.slug,
        destination: opened.name,
        count: pieces.length,
        mode: say(mode === 'hot' ? 'backup.mode.hot' : 'backup.mode.stop'),
      }),
    );
    const context = await openDeploymentContext(deployment.id, { connect: { retries: 2 } });
    session = context.session;
    const driver = getDriver(deployment.runtime);
    const store = opened.store;

    const stopForCopy = mode === 'stop' && !stopped;
    if (stopForCopy) {
      onLog(say('backup.briefStop'));
      await driver.stop(context.ctx, (line) => onLog(`  ${line}`));
    }

    const stored: StoredPiece[] = [];
    try {
      for (const piece of pieces) {
        const file = pieceFile(piece);
        const label =
          piece.kind === 'volume'
            ? say('backup.volumeLabel', { volume: piece.volume, service: piece.service })
            : say('backup.dumpLabel', { engine: piece.engine, service: piece.service });
        const started = Date.now();
        const result =
          piece.kind === 'volume'
            ? await storePiece(
                store,
                `${location}/${file}`,
                (sink) => driver.exportVolume(context.ctx, piece.service, piece.volume, sink),
                { gzip: false },
              )
            : await storePiece(
                store,
                `${location}/${file}`,
                (sink) =>
                  driver.exportFromService(
                    context.ctx,
                    piece.service,
                    dumpCommand(piece.engine),
                    sink,
                  ),
                { gzip: true },
              );
        stored.push({ ...piece, file, ...result });
        onLog(
          say('backup.pieceStored', {
            label,
            size: formatBytes(result.bytes, language),
            seconds: ((Date.now() - started) / 1000).toFixed(1),
          }),
        );
      }
    } finally {
      if (stopForCopy) {
        onLog(say('backup.restarting'));
        await driver.start(context.ctx, (line) => onLog(`  ${line}`));
      }
    }

    const manifest: BackupManifest = {
      format: 1,
      kind: 'application',
      id: backupId,
      createdAt: startedAt.toISOString(),
      mode,
      trigger: request.trigger,
      application: { id: application.id, slug: application.slug },
      target: target
        ? { id: target.id, name: target.name, runtime: deployment.runtime }
        : { id: request.targetId, name: request.targetId, runtime: deployment.runtime },
      spec,
      pieces: stored,
    };
    await store.put(
      `${location}/${MANIFEST_FILE}`,
      Readable.from([await encryptBuffer(Buffer.from(JSON.stringify(manifest)))]),
    );
    const bytes = stored.reduce((sum, piece) => sum + piece.bytes, 0);
    await finishBackupRecord(backupId, { status: 'success', manifest, bytes });
    onLog(say('backup.done', { size: formatBytes(bytes, language) }));

    // Une sauvegarde de sûreté reste hors de la rotation : elle précède une
    // restauration, et la rétention pourrait retirer la sauvegarde même qu'on
    // s'apprête à restaurer. La prochaine sauvegarde ordinaire fera le tri.
    if (request.trigger !== 'pre_restore') {
      await applyRetention(
        store,
        { kind: 'application', applicationId: application.id },
        opened.id,
        policy.configured ? policy.retention : DEFAULT_BACKUP_RETENTION,
        onLog,
      );
    }
    return { status: 'success', backupId, bytes };
  } catch (error) {
    const message = errorMessage(error);
    onLog(`✗ ${message}`);
    if (backupId) {
      await finishBackupRecord(backupId, { status: 'failed', error: message });
      // Un morceau à moitié déposé n'est pas une sauvegarde : il part.
      const record = await getBackup(backupId);
      if (record && opened) {
        await opened.store.removePrefix(`${record.location}/`).catch(() => undefined);
      }
    }
    await logAudit({
      actorId: request.actorId,
      action: 'backup.failed',
      resourceType: 'application',
      resourceId: application.id,
      after: {
        kind: 'application',
        backupId,
        application: application.slug,
        applicationName: application.name,
        targetName: target?.name ?? null,
        trigger: request.trigger,
        mode,
        error: message,
      },
      ip: request.ip,
    });
    return { status: 'failed', backupId, error: message };
  } finally {
    if (session) await disconnect(session);
    await opened?.store.close().catch(() => undefined);
  }
}
