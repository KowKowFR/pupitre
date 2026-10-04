import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { LocalDestinationConfig } from '../destinations.js';
import { BackupStoreError, probeKey, type BackupStore, type StoredObject } from './types.js';
import type { UiLanguage } from '../../i18n.js';
import { backupSay, type BackupSay } from '../messages.js';

/**
 * A folder mounted in the worker's container — typically a NAS's NFS or SMB
 * share, mounted on the host then in the container. For the worker, it is a
 * folder: nothing more to know.
 *
 * A key never leaves the folder: a path that would escape it is refused.
 */
export class LocalBackupStore implements BackupStore {
  readonly kind = 'local' as const;
  private readonly root: string;

  private readonly say: BackupSay;

  constructor(config: LocalDestinationConfig, language: UiLanguage = 'fr') {
    this.root = resolve(config.path);
    this.say = backupSay(language);
  }

  private path(key: string): string {
    const target = resolve(this.root, key);
    if (target !== this.root && !target.startsWith(`${this.root}/`)) {
      throw new BackupStoreError(this.say('store.keyOutside', { key }));
    }
    return target;
  }

  async put(key: string, body: Readable): Promise<number> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    let total = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        total += chunk.length;
        callback(null, chunk);
      },
    });
    // Written next to it then renamed: a half-written file never carries the final
    // name.
    const partial = `${target}.partial`;
    try {
      await pipeline(body, counter, createWriteStream(partial));
      await import('node:fs/promises').then((fs) => fs.rename(partial, target));
    } catch (error) {
      await rm(partial, { force: true });
      throw new BackupStoreError(
        this.say('store.writeFailed', {
          key,
          error: error instanceof Error ? error.message : String(error),
        }),
        error,
      );
    }
    return total;
  }

  async get(key: string): Promise<Readable> {
    const target = this.path(key);
    await stat(target).catch((error: unknown) => {
      throw new BackupStoreError(`« ${key} » introuvable`, error);
    });
    return createReadStream(target);
  }

  async remove(key: string): Promise<void> {
    await unlink(this.path(key)).catch(() => undefined);
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const objects: StoredObject[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = join(dir, entry.name);
        const key = relative(this.root, full).split('\\').join('/');
        if (entry.isDirectory()) {
          if (prefix.startsWith(key) || key.startsWith(prefix)) await walk(full);
        } else if (key.startsWith(prefix) && !key.endsWith('.partial')) {
          const info = await stat(full);
          objects.push({ key, bytes: info.size, modifiedAt: info.mtime.toISOString() });
        }
      }
    };
    await walk(this.root);
    return objects;
  }

  async removePrefix(prefix: string): Promise<number> {
    const objects = await this.list(prefix);
    for (const object of objects) await this.remove(object.key);
    // Folders that became empty go too, climbing up to the root — `rmdir` refuses a
    // folder that still contains something.
    const dirs = [...new Set(objects.map((object) => dirname(this.path(object.key))))];
    for (const start of dirs) {
      let dir = start;
      while (dir.startsWith(`${this.root}/`)) {
        const removed = await rmdir(dir).then(
          () => true,
          () => false,
        );
        if (!removed) break;
        dir = dirname(dir);
      }
    }
    return objects.length;
  }

  async check(): Promise<void> {
    const info = await stat(this.root).catch(() => null);
    if (!info?.isDirectory()) {
      throw new BackupStoreError(this.say('store.localMissing', { path: this.root }));
    }
    const target = this.path(probeKey());
    await writeFile(target, 'pupitre');
    const back = await readFile(target, 'utf8');
    await unlink(target);
    if (back !== 'pupitre') throw new BackupStoreError(this.say('store.probeMismatch'));
  }

  async close(): Promise<void> {}
}
