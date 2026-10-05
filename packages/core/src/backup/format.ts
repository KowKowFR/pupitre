import { createCipheriv, createDecipheriv, randomBytes, type DecipherGCM } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { deriveBackupKey } from '../crypto.js';
import type { UiLanguage } from '../i18n.js';
import { backupSay } from './messages.js';

/**
 * Le format d'un fichier de sauvegarde, `.pupb` :
 *
 *   en-tête   « PUPB », version (1 octet), sel (16), nonce (12)
 *   corps     AES-256-GCM, l'en-tête en données associées
 *   fin       l'étiquette d'authentification (16)
 *
 * Chiffré **en flux** : une archive de plusieurs gigaoctets ne passe jamais
 * entière en mémoire. Le revers du GCM en flux : l'authenticité n'est connue
 * qu'au dernier octet. Une restauration télécharge donc et vérifie **avant**
 * d'appliquer quoi que ce soit — un fichier altéré est refusé, jamais à moitié
 * restauré.
 */

const MAGIC = Buffer.from('PUPB', 'ascii');
const VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const BACKUP_HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES + IV_BYTES;

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

export function createEncryptStream(masterKey?: string): Transform {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv]);
  const cipher = createCipheriv('aes-256-gcm', deriveBackupKey(salt, masterKey), iv);
  cipher.setAAD(header);
  let started = false;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      if (!started) {
        started = true;
        this.push(header);
      }
      callback(null, cipher.update(chunk));
    },
    flush(callback: TransformCallback) {
      if (!started) this.push(header);
      this.push(cipher.final());
      callback(null, cipher.getAuthTag());
    },
  });
}

/**
 * Déchiffre en flux. Les seize derniers octets sont retenus jusqu'à la fin :
 * c'est l'étiquette. Une étiquette fausse — fichier tronqué, altéré, ou
 * `MASTER_KEY` différente — fait échouer le flux au dernier moment, en
 * `BackupFormatError`.
 */
export function createDecryptStream(masterKey?: string, language: UiLanguage = 'fr'): Transform {
  const say = backupSay(language);
  let header: Buffer = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  let held: Buffer = Buffer.alloc(0);

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      try {
        let data = chunk;
        if (!decipher) {
          header = Buffer.concat([header, data]);
          if (header.length < BACKUP_HEADER_BYTES) return callback();
          data = header.subarray(BACKUP_HEADER_BYTES);
          header = header.subarray(0, BACKUP_HEADER_BYTES);
          if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
            throw new BackupFormatError("ce n'est pas un fichier de sauvegarde Pupitre");
          }
          if (header[MAGIC.length] !== VERSION) {
            throw new BackupFormatError(`version de format inconnue : ${header[MAGIC.length]}`);
          }
          const salt = header.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_BYTES);
          const iv = header.subarray(MAGIC.length + 1 + SALT_BYTES);
          decipher = createDecipheriv('aes-256-gcm', deriveBackupKey(salt, masterKey), iv);
          decipher.setAAD(header);
        }
        const combined = Buffer.concat([held, data]);
        const usable = Math.max(0, combined.length - TAG_BYTES);
        held = combined.subarray(usable);
        callback(null, usable > 0 ? decipher.update(combined.subarray(0, usable)) : undefined);
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback: TransformCallback) {
      if (!decipher || held.length !== TAG_BYTES) {
        return callback(new BackupFormatError(say('format.truncated')));
      }
      try {
        decipher.setAuthTag(held);
        callback(null, decipher.final());
      } catch {
        callback(new BackupFormatError(say('format.authFailed')));
      }
    },
  });
}

/** Chiffre un contenu court — le manifeste. */
export async function encryptBuffer(plain: Buffer, masterKey?: string): Promise<Buffer> {
  return collect(createEncryptStream(masterKey), plain);
}

export async function decryptBuffer(sealed: Buffer, masterKey?: string): Promise<Buffer> {
  return collect(createDecryptStream(masterKey), sealed);
}

function collect(transform: Transform, input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    transform.on('data', (chunk: Buffer) => chunks.push(chunk));
    transform.on('end', () => resolve(Buffer.concat(chunks)));
    transform.on('error', reject);
    transform.end(input);
  });
}
