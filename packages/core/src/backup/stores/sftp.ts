import { posix } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { NodeSSH } from 'node-ssh';
import type { SFTPWrapper, Stats } from 'ssh2';
import { hostKeyFingerprint } from '../../ssh/client.js';
import type { SftpDestinationConfig, SftpDestinationSecrets } from '../destinations.js';
import { BackupStoreError, probeKey, type BackupStore, type StoredObject } from './types.js';

/**
 * Une destination SFTP — un NAS, ou n'importe quel serveur SSH.
 *
 * Le chemin de base est relatif au dossier d'accueil du compte, comme le
 * comprend tout serveur SFTP. L'empreinte de la clé d'hôte, si elle est donnée,
 * est vérifiée : une machine qui en présente une autre ne reçoit rien.
 */

const READY_TIMEOUT_MS = 15_000;

function call<T>(
  run: (done: (error: Error | null | undefined, value?: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) =>
    run((error, value) => (error ? reject(error) : resolve(value as T))),
  );
}

export class SftpBackupStore implements BackupStore {
  readonly kind = 'sftp' as const;
  private ssh: NodeSSH | null = null;
  private sftp: SFTPWrapper | null = null;

  constructor(
    private readonly config: SftpDestinationConfig,
    private readonly secrets: SftpDestinationSecrets,
  ) {}

  private path(key: string): string {
    return posix.join(this.config.path || '.', key);
  }

  private async open(): Promise<SFTPWrapper> {
    if (this.sftp) return this.sftp;
    const ssh = new NodeSSH();
    const expected = this.config.fingerprint?.replace(/=+$/, '');
    let presented: string | null = null;
    try {
      await ssh.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        ...(this.secrets.privateKey ? { privateKey: this.secrets.privateKey } : {}),
        ...(this.secrets.password ? { password: this.secrets.password } : {}),
        readyTimeout: READY_TIMEOUT_MS,
        ...(expected
          ? {
              hostVerifier: (key: Buffer) => {
                presented = hostKeyFingerprint(key);
                return presented === expected;
              },
            }
          : {}),
      });
    } catch (error) {
      if (expected && presented && presented !== expected) {
        throw new BackupStoreError(
          `SFTP : la clé d'hôte de ${this.config.host} ne correspond pas (${presented}) — refus`,
          error,
        );
      }
      throw new BackupStoreError(
        `SFTP : connexion impossible à ${this.config.host}:${this.config.port} — ` +
          (error instanceof Error ? error.message : String(error)),
        error,
      );
    }
    this.ssh = ssh;
    this.sftp = await ssh.requestSFTP();
    return this.sftp;
  }

  /** `mkdir -p`, un segment à la fois. */
  private async ensureDir(sftp: SFTPWrapper, dir: string): Promise<void> {
    let current = '';
    for (const segment of dir.split('/').filter((part) => part && part !== '.')) {
      current = current ? `${current}/${segment}` : segment;
      const exists = await call<Stats>((done) => sftp.stat(current, done)).then(
        () => true,
        () => false,
      );
      if (!exists) {
        await call<void>((done) => sftp.mkdir(current, done)).catch(async (error: unknown) => {
          // Créé entre-temps par un envoi concurrent : sans importance.
          const now = await call<Stats>((done) => sftp.stat(current, done)).then(
            () => true,
            () => false,
          );
          if (!now) throw error;
        });
      }
    }
  }

  async put(key: string, body: Readable): Promise<number> {
    const sftp = await this.open();
    const target = this.path(key);
    await this.ensureDir(sftp, posix.dirname(target));
    let total = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        total += chunk.length;
        callback(null, chunk);
      },
    });
    try {
      await pipeline(body, counter, sftp.createWriteStream(target));
    } catch (error) {
      throw new BackupStoreError(
        `SFTP : écriture de « ${key} » impossible — ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    return total;
  }

  async get(key: string): Promise<Readable> {
    const sftp = await this.open();
    const target = this.path(key);
    await call<Stats>((done) => sftp.stat(target, done)).catch((error: unknown) => {
      throw new BackupStoreError(`SFTP : « ${key} » introuvable`, error);
    });
    return sftp.createReadStream(target);
  }

  async remove(key: string): Promise<void> {
    const sftp = await this.open();
    await call<void>((done) => sftp.unlink(this.path(key), done)).catch(() => undefined);
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const sftp = await this.open();
    const root = this.config.path || '.';
    const objects: StoredObject[] = [];
    // On descend depuis le dossier le plus profond que le préfixe désigne.
    const start = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
    const walk = async (relative: string): Promise<void> => {
      const entries = await call<Array<{ filename: string; attrs: Stats }>>((done) =>
        sftp.readdir(posix.join(root, relative || '.'), done),
      ).catch(() => []);
      for (const entry of entries) {
        const key = relative ? `${relative}/${entry.filename}` : entry.filename;
        if (entry.attrs.isDirectory()) {
          if (prefix.startsWith(key) || key.startsWith(prefix)) await walk(key);
        } else if (key.startsWith(prefix)) {
          objects.push({
            key,
            bytes: entry.attrs.size,
            modifiedAt: new Date(entry.attrs.mtime * 1000).toISOString(),
          });
        }
      }
    };
    await walk(start);
    return objects;
  }

  async removePrefix(prefix: string): Promise<number> {
    const sftp = await this.open();
    const objects = await this.list(prefix);
    for (const object of objects) await this.remove(object.key);
    // Les dossiers vidés partent aussi, du plus profond au moins profond.
    const dirs = [...new Set(objects.map((object) => posix.dirname(object.key)))].sort(
      (a, b) => b.length - a.length,
    );
    for (const dir of dirs) {
      await call<void>((done) => sftp.rmdir(this.path(dir), done)).catch(() => undefined);
    }
    return objects.length;
  }

  async check(): Promise<void> {
    const key = probeKey();
    await this.put(key, Readable.from([Buffer.from('pupitre')]));
    const back = await this.get(key);
    const chunks: Buffer[] = [];
    for await (const chunk of back) chunks.push(Buffer.from(chunk as Uint8Array));
    await this.remove(key);
    if (Buffer.concat(chunks).toString() !== 'pupitre') {
      throw new BackupStoreError('SFTP : le fichier témoin relu ne correspond pas');
    }
  }

  async close(): Promise<void> {
    this.sftp?.end();
    this.ssh?.dispose();
    this.sftp = null;
    this.ssh = null;
  }
}
