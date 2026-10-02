import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { backupManifestSchema, readyCommand, restoreCommand } from '@pupitre/core/backup';
import { errorMessage, parseAppSpec } from '@pupitre/core';
import { getDriver, type DriverContext } from '@pupitre/core/drivers';
import { disconnect } from '@pupitre/core/ssh';
import { Writable } from 'node:stream';
import {
  getApplication,
  getBackup,
  getBackupPolicy,
  getTarget,
  listLiveDeployments,
  logAudit,
} from '@pupitre/db';
import { openDeploymentContext } from '../deploy/context.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { backupApplication } from './application.js';
import { BackupError, fetchPiece, openStore } from './shared.js';

/**
 * Restaurer une sauvegarde d'application sur une cible où elle tourne.
 *
 *   1. une sauvegarde de sûreté de l'état actuel, si demandé (par défaut) :
 *      une restauration se défait comme elle s'est faite ;
 *   2. chaque morceau est téléchargé et **vérifié** — empreinte, puis
 *      authenticité du chiffrement — avant que quoi que ce soit change ;
 *   3. les volumes sont remplacés application arrêtée, puis elle redémarre ;
 *   4. les exports de bases sont rejoués une fois chaque base prête ;
 *   5. l'application redémarre une dernière fois, pour se reconnecter à des
 *      données qu'elle n'a pas vues changer.
 *
 * Un morceau dont le service ou le volume n'existe plus dans l'AppSpec en
 * service est sauté, et dit : on ne recrée pas un volume que personne ne monte.
 */

const READY_TIMEOUT_MS = 180_000;

const sink = () =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

async function waitForDatabase(
  driver: ReturnType<typeof getDriver>,
  ctx: DriverContext,
  service: string,
  command: string,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      await driver.exportFromService(ctx, service, command, sink());
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  throw new BackupError(`la base « ${service} » ne répond pas : ${errorMessage(last)}`);
}

export async function restoreApplicationBackup(request: {
  backupId: string;
  targetId: string;
  safetyBackup: boolean;
  actorId: string | null;
  ip: string | null;
}): Promise<{ status: 'success' | 'failed'; error: string | null }> {
  const lines: string[] = [];
  const onLog = (line: string) => {
    lines.push(line);
    logger.info({ backupId: request.backupId }, line);
  };

  const backup = await getBackup(request.backupId);
  const application = backup?.applicationId ? await getApplication(backup.applicationId) : null;
  const target = await getTarget(request.targetId);
  let workdir: string | null = null;
  let session: Awaited<ReturnType<typeof openDeploymentContext>>['session'] | null = null;
  let opened: Awaited<ReturnType<typeof openStore>> | null = null;
  let safetyId: string | null = null;

  try {
    if (
      !backup ||
      backup.kind !== 'application' ||
      backup.status !== 'success' ||
      !backup.manifest
    ) {
      throw new BackupError("cette sauvegarde n'est pas restaurable");
    }
    if (!application) throw new BackupError("l'application de cette sauvegarde a été supprimée");
    const manifest = backupManifestSchema.parse(backup.manifest);

    const [live] = await listLiveDeployments({
      applicationId: application.id,
      targetId: request.targetId,
    });
    const deployment = live?.inService ?? null;
    if (!deployment) throw new BackupError("l'application ne tourne pas sur cette cible");
    if (deployment.stoppedAt) {
      throw new BackupError("l'application est arrêtée : démarrez-la avant de restaurer");
    }

    // 1. Tout télécharger et vérifier, avant de toucher à quoi que ce soit.
    opened = await openStore(backup.destinationId);
    workdir = await mkdtemp(join(env.BACKUP_TMP_DIR, 'pupitre-restore-'));
    const spec = parseAppSpec(deployment.appSpec);
    const files = new Map<string, string>();
    for (const piece of manifest.pieces) {
      if (piece.kind === 'database') continue;
      const service = spec.services.find((candidate) => candidate.name === piece.service);
      const present =
        service &&
        (piece.kind === 'dump' || service.volumes.some((volume) => volume.name === piece.volume));
      if (!present) {
        onLog(
          `⚠ « ${piece.kind === 'volume' ? `${piece.service}/${piece.volume}` : piece.service} » ` +
            "n'existe plus dans l'AppSpec en service — morceau ignoré",
        );
        continue;
      }
      const local = join(workdir, piece.file.replace(/\.pupb$/, ''));
      await fetchPiece(opened.store, `${backup.location}/${piece.file}`, piece.sha256, local);
      files.set(piece.file, local);
      onLog(`✓ ${piece.file} téléchargé et vérifié`);
    }

    // 2. L'état actuel, au plus près de son remplacement. Après le téléchargement :
    //    la sauvegarde de sûreté ne doit rien pouvoir retirer de ce qu'on restaure.
    if (request.safetyBackup) {
      onLog("sauvegarde de sûreté de l'état actuel");
      const policy = await getBackupPolicy(application.id);
      const safety = await backupApplication({
        applicationId: application.id,
        targetId: request.targetId,
        trigger: 'pre_restore',
        mode: policy.mode,
        actorId: request.actorId,
        ip: request.ip,
        onLog: (line) => onLog(`  ${line}`),
      });
      if (safety.status === 'failed') {
        throw new BackupError(
          `sauvegarde de sûreté impossible — restauration annulée : ${safety.error}`,
        );
      }
      if (safety.status === 'success') safetyId = safety.backupId;
    }

    const context = await openDeploymentContext(deployment.id, { connect: { retries: 2 } });
    session = context.session;
    const driver = getDriver(deployment.runtime);
    const ctx = context.ctx;
    const volumes = manifest.pieces.filter(
      (piece): piece is Extract<typeof piece, { kind: 'volume' }> =>
        piece.kind === 'volume' && files.has(piece.file),
    );
    const dumps = manifest.pieces.filter(
      (piece): piece is Extract<typeof piece, { kind: 'dump' }> =>
        piece.kind === 'dump' && files.has(piece.file),
    );

    // 3. Les volumes, application arrêtée.
    if (volumes.length > 0) {
      onLog("arrêt de l'application pour remplacer ses volumes");
      await driver.stop(ctx, (line) => onLog(`  ${line}`));
      try {
        for (const piece of volumes) {
          await driver.importVolume(
            ctx,
            piece.service,
            piece.volume,
            createReadStream(files.get(piece.file) as string),
          );
          onLog(`✓ volume « ${piece.volume} » de « ${piece.service} » restauré`);
        }
      } finally {
        onLog("redémarrage de l'application");
        await driver.start(ctx, (line) => onLog(`  ${line}`));
      }
    }

    // 4. Les bases, une fois prêtes.
    for (const piece of dumps) {
      await waitForDatabase(driver, ctx, piece.service, readyCommand(piece.engine));
      await driver.importIntoService(
        ctx,
        piece.service,
        restoreCommand(piece.engine),
        createReadStream(files.get(piece.file) as string).pipe(createGunzip()),
      );
      onLog(`✓ base « ${piece.service} » (${piece.engine}) restaurée`);
    }
    if (dumps.length > 0) {
      onLog("redémarrage de l'application, pour qu'elle se reconnecte");
      await driver.restart(ctx, (line) => onLog(`  ${line}`));
    }

    await logAudit({
      actorId: request.actorId,
      action: 'backup.restored',
      resourceType: 'application',
      resourceId: application.id,
      after: {
        backupId: backup.id,
        backupDate: backup.startedAt.toISOString(),
        targetName: target?.name ?? null,
        safetyBackupId: safetyId,
        pieces: [...files.keys()],
        log: lines.slice(-60),
      },
      ip: request.ip,
    });
    return { status: 'success', error: null };
  } catch (error) {
    const message = errorMessage(error);
    onLog(`✗ ${message}`);
    await logAudit({
      actorId: request.actorId,
      action: 'backup.restore.failed',
      resourceType: 'application',
      resourceId: application?.id ?? backup?.applicationId ?? null,
      after: {
        backupId: request.backupId,
        targetName: target?.name ?? null,
        safetyBackupId: safetyId,
        error: message,
        log: lines.slice(-60),
      },
      ip: request.ip,
    });
    return { status: 'failed', error: message };
  } finally {
    if (session) await disconnect(session);
    await opened?.store.close().catch(() => undefined);
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}
