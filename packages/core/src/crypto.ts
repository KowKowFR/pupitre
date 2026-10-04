import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Symmetric encryption of the secrets stored in the database (SSH credentials
 * first, various tokens later).
 *
 * Output format: `version:iv:authTag:ciphertext`
 * The last three fields are base64 — the base64 alphabet contains no `:`, so the
 * split is unambiguous.
 *
 * The version prefix will allow a key rotation: a future `v2` will live
 * alongside the `v1` values already in the database, and `decrypt()` will pick
 * the algorithm from the prefix.
 */

export const CURRENT_CRYPTO_VERSION = 'v1' as const;

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, the recommended size for GCM
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256
const MIN_MASTER_KEY_BYTES = 32;

/**
 * HKDF context: freezes the usage domain of the derived key.
 *
 * **This string does not follow the product's name and must never change.** It
 * goes into the derivation: changing it produces another key from the same
 * `MASTER_KEY`, and makes everything already encrypted in the database
 * unreadable at once — SSH credentials, application secrets, AI key, channel
 * secrets, probe webhooks. The panel has been called Pupitre since, and this
 * value keeps the old name for that reason alone. Changing it would require
 * decrypting with the old salt then encrypting again with the new one, in a
 * migration written for that.
 */
const HKDF_SALT = 'bootstrap-tp-v2/secret-encryption';
const HKDF_INFO = 'aes-256-gcm/v1';

/** `MASTER_KEY` absente, trop courte ou illisible. */
export class MasterKeyError extends Error {
  override readonly name = 'MasterKeyError';
}

/** Encrypted value corrupted, truncated, tampered with or encrypted with another key. */
export class DecryptionError extends Error {
  override readonly name = 'DecryptionError';
}

/**
 * Raw key material.
 * `openssl rand -hex 32` produces 64 hexadecimal characters, decoded into 32
 * bytes. Any other string is taken as is and must weigh at least 32 bytes.
 */
function toKeyMaterial(masterKey: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(masterKey)) {
    return Buffer.from(masterKey, 'hex');
  }
  const raw = Buffer.from(masterKey, 'utf8');
  if (raw.byteLength < MIN_MASTER_KEY_BYTES) {
    throw new MasterKeyError(
      `MASTER_KEY fait ${raw.byteLength} octets, minimum ${MIN_MASTER_KEY_BYTES}. ` +
        'Générer une clé avec : openssl rand -hex 32',
    );
  }
  return raw;
}

/**
 * Validates `MASTER_KEY` and returns the derived key.
 * Called at the panel's and the worker's startup: the application refuses to
 * start with a missing or too weak key.
 */
export function deriveKey(masterKey: string | undefined): Buffer {
  if (masterKey === undefined || masterKey === '') {
    throw new MasterKeyError(
      'MASTER_KEY est absente. Générer une clé avec : openssl rand -hex 32',
    );
  }
  const ikm = toKeyMaterial(masterKey);
  return Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, HKDF_INFO, KEY_LENGTH));
}

/**
 * A backup file's key: drawn from `MASTER_KEY`, but **not** the key of the
 * secrets in the database — one use, one key. The salt is specific to each file
 * and stored in its header: two backups never share the same key, and a single
 * `MASTER_KEY` is enough to read them all.
 */
export function deriveBackupKey(
  salt: Buffer,
  masterKey: string | undefined = process.env.MASTER_KEY,
): Buffer {
  if (masterKey === undefined || masterKey === '') {
    throw new MasterKeyError(
      'MASTER_KEY est absente : impossible de chiffrer ou de relire une sauvegarde.',
    );
  }
  return Buffer.from(
    hkdfSync('sha256', toKeyMaterial(masterKey), salt, 'pupitre-backup-v1', KEY_LENGTH),
  );
}

let cachedKey: Buffer | null = null;

function activeKey(): Buffer {
  cachedKey ??= deriveKey(process.env.MASTER_KEY);
  return cachedKey;
}

/**
 * Is the key valid but notoriously guessable?
 *
 * `deriveKey()` only checks a **length**, and sixty-four zeros make thirty-two
 * bytes just like a real key. The `.env.example` ships precisely that value,
 * and an instance set up by copying the example therefore encrypts its SSH
 * credentials under a published key. It starts, it decrypts, all tests pass —
 * the flaw is invisible by construction, and that is exactly why it must be
 * said out loud.
 *
 * We do not refuse to start: the database already contains values encrypted
 * under that key, and an instance that no longer starts is an instance whose
 * credentials can no longer be taken out to encrypt them again. We warn, and
 * rotation stays the operator's decision.
 *
 * The criterion is the **shape**, not a list of examples to keep up to date: a
 * randomly drawn key never has a single distinct character, nor a short
 * repeated pattern. No real key falls into this net.
 */
export function masterKeyWeakness(masterKey: string | undefined): string | null {
  return secretWeakness(masterKey, 'MASTER_KEY');
}

/**
 * The same **shape** judgment, for any installation secret — `BETTER_AUTH_SECRET`
 * too, for which the `.env.example` ships a repeated phrase. `name` is only used
 * for the rendered sentence.
 */
export function secretWeakness(value: string | undefined, name: string): string | null {
  if (value === undefined || value === '') return null;

  const distinct = new Set(value).size;
  if (distinct <= 2) {
    return `${name} ne contient que ${distinct} caractère(s) distinct(s)`;
  }

  // A pattern of 15 characters or fewer, repeated to the end: it is the shape of
  // examples, never that of a random draw.
  //
  // The repetition does not have to fall exactly: the `.env.example` passphrase is
  // 39 characters for a 10-character pattern, its last occurrence is truncated.
  // Requiring an exact division therefore let the example's own value through,
  // which the first draft did.
  for (let size = 1; size <= 15 && size * 2 <= value.length; size += 1) {
    const unit = value.slice(0, size);
    const tiled = unit.repeat(Math.ceil(value.length / size)).slice(0, value.length);
    if (tiled === value) {
      return `${name} répète le motif « ${unit} »`;
    }
  }

  return null;
}

/**
 * Checks `MASTER_KEY` at startup and caches the derived key.
 * To call once at boot, before serving the slightest request.
 *
 * Returns the reason the key is weak, or `null`. The caller decides what to do
 * with it — here we do not know yet which log we write with.
 */
export function assertMasterKey(): string | null {
  activeKey();
  return masterKeyWeakness(process.env.MASTER_KEY);
}

/** Resets the memorized key. Reserved to tests. */
export function resetKeyCache(): void {
  cachedKey = null;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, activeKey(), iv, { authTagLength: AUTH_TAG_LENGTH });
  // The version goes into the authenticated data: impossible to downgrade a `v2`
  // to `v1` without invalidating the tag.
  cipher.setAAD(Buffer.from(CURRENT_CRYPTO_VERSION, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [
    CURRENT_CRYPTO_VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4) {
    throw new DecryptionError(
      `Format attendu « version:iv:authTag:ciphertext », ${parts.length} champ(s) reçu(s)`,
    );
  }

  const [version, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  if (version !== CURRENT_CRYPTO_VERSION) {
    throw new DecryptionError(`Version de chiffrement inconnue « ${version} »`);
  }

  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');

  if (iv.byteLength !== IV_LENGTH) {
    throw new DecryptionError(`IV de ${iv.byteLength} octets, ${IV_LENGTH} attendus`);
  }
  if (authTag.byteLength !== AUTH_TAG_LENGTH) {
    throw new DecryptionError(
      `Tag d'authentification de ${authTag.byteLength} octets, ${AUTH_TAG_LENGTH} attendus`,
    );
  }

  const decipher = createDecipheriv(ALGORITHM, activeKey(), iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAAD(Buffer.from(version, 'utf8'));
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // `final()` fails as soon as the tag does not match: tampering with the
    // ciphertext, the IV, the tag, or decryption with another key.
    throw new DecryptionError(
      'Déchiffrement impossible : donnée altérée ou chiffrée avec une autre MASTER_KEY',
    );
  }
}

/** Constant-time comparison, for tokens and hashes. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.byteLength !== bufB.byteLength) return false;
  return timingSafeEqual(bufA, bufB);
}
