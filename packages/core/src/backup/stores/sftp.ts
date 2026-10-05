import { posix } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { NodeSSH } from 'node-ssh';
import type { SFTPWrapper, Stats } from 'ssh2';
import { hostKeyFingerprint } from '../../ssh/client.js';
import type { SftpDestinationConfig, SftpDestinationSecrets } from '../destinations.js';
import { BackupStoreError, probeKey, type BackupStore, type StoredObject } from './types.js';
import type { UiLanguage } from '../../i18n.js';
import { backupSay, type BackupSay } from '../messages.js';

/**
 * An SFTP destination — a NAS, or any SSH server.
 *
 * The base path is relative to the account's home folder, as any SFTP server
 * understands it. The host key's fingerprint, if given, is checked: a machine
 * that presents another one receives nothing.
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

  private readonly say: BackupSay;

  constructor(
    private readonly config: SftpDestinationConfig,
    private readonly secrets: SftpDestinationSecrets,
    language: UiLanguage,
  ) {
    this.say = backupSay(language);
  }

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
          this.say('sftp.hostKey', { host: this.config.host, presented }),
          error,
        );
      }
      throw new BackupStoreError(
        this.say('sftp.connectFailed', {
          host: this.config.host,
          port: this.config.port,
          detail: error instanceof Error ? error.message : String(error),
        }),
        error,
      );
    }
    this.ssh = ssh;
    this.sftp = await ssh.requestSFTP();
    return this.sftp;
  }

  /** `mkdir -p`, one segment at a time. */
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
          // Created in the meantime by a concurrent send: no matter.
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
        this.say('sftp.writeFailed', {
          key,
          error: error instanceof Error ? error.message : String(error),
        }),
        error,
      );
    }
    return total;
  }

  async get(key: string): Promise<Readable> {
    const sftp = await this.open();
    const target = this.path(key);
    await call<Stats>((done) => sftp.stat(target, done)).catch((error: unknown) => {
      throw new BackupStoreError(this.say('sftp.notFound', { key }), error);
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
    // We go down from the deepest folder the prefix designates.
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
    // Emptied folders go too, from the deepest to the shallowest.
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
      throw new BackupStoreError(this.say('sftp.probeMismatch'));
    }
  }

  async close(): Promise<void> {
    this.sftp?.end();
    this.ssh?.dispose();
    this.sftp = null;
    this.ssh = null;
  }
}
