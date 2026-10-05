import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Symmetric encryption of the secrets stored in the database (SSH credentials
 * first, various tokens later).
 *
 * Output format: `v2:keyId:iv:authTag:ciphertext`
 * `keyId` names the `MASTER_KEY` the value was encrypted with — a fingerprint,
 * which reveals nothing of it. The last three fields are base64 — the base64
 * alphabet contains no `:`, so the split is unambiguous.
 *
 * ── Rotation ────────────────────────────────────────────────────────────────
 * `MASTER_KEY` is the current key: everything is encrypted with it.
 * `MASTER_KEY_PREVIOUS` lists, separated by commas, the keys it replaced: they
 * are only used to read. A `v2` value names its key; a `v1` value — the first
 * format, without an identifier — is tried with the current key, then with the
 * previous ones. The worker's `crypto rotate` command encrypts again under the
 * current key everything that is not yet; once it is done, and once the backups
 * made under an old key have expired, `MASTER_KEY_PREVIOUS` can be removed.
 */

export const CURRENT_CRYPTO_VERSION = 'v2' as const;
/** The first format, without a key identifier: still read, never written. */
const LEGACY_CRYPTO_VERSION = 'v1';

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

/** `MASTER_KEY` missing, too short or unreadable. */
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
      `MASTER_KEY is ${raw.byteLength} bytes, minimum ${MIN_MASTER_KEY_BYTES}. ` +
        'Generate a key with: openssl rand -hex 32',
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
    throw new MasterKeyError('MASTER_KEY is missing. Generate a key with: openssl rand -hex 32');
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
    throw new MasterKeyError('MASTER_KEY is missing: a backup can be neither encrypted nor read.');
  }
  return Buffer.from(
    hkdfSync('sha256', toKeyMaterial(masterKey), salt, 'pupitre-backup-v1', KEY_LENGTH),
  );
}

/** A key of the ring: the key derived from a `MASTER_KEY`, and its fingerprint. */
type RingKey = { id: string; key: Buffer; masterKey: string };

function fingerprint(derived: Buffer): string {
  return createHmac('sha256', derived).update('pupitre/key-id').digest('hex').slice(0, 8);
}

/**
 * A `MASTER_KEY`'s public fingerprint: eight hexadecimal characters that name it
 * — in an encrypted value, a backup's header, a status — without revealing it.
 */
export function keyIdOf(masterKey: string): string {
  return fingerprint(deriveKey(masterKey));
}

function ringKey(masterKey: string | undefined): RingKey {
  const key = deriveKey(masterKey);
  return { id: fingerprint(key), key, masterKey: masterKey as string };
}

/** `MASTER_KEY_PREVIOUS`: the replaced keys, separated by commas. */
function previousMasterKeys(): string[] {
  return (process.env.MASTER_KEY_PREVIOUS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

let cachedRing: { current: RingKey; previous: RingKey[] } | null = null;

function ring(): { current: RingKey; previous: RingKey[] } {
  if (!cachedRing) {
    const current = ringKey(process.env.MASTER_KEY);
    const previous: RingKey[] = [];
    for (const masterKey of previousMasterKeys()) {
      const candidate = ringKey(masterKey);
      if (candidate.id !== current.id && !previous.some((key) => key.id === candidate.id)) {
        previous.push(candidate);
      }
    }
    cachedRing = { current, previous };
  }
  return cachedRing;
}

/** The current key's fingerprint — the one everything is encrypted with. */
export function currentKeyId(): string {
  return ring().current.id;
}

/** The fingerprints of the keys `MASTER_KEY_PREVIOUS` lists, without the current one. */
export function previousKeyIds(): string[] {
  return ring().previous.map((key) => key.id);
}

/**
 * The `MASTER_KEY`s a backup may have been encrypted with: the current one first,
 * then the previous ones. A backup file derives its own key from one of them.
 */
export function backupMasterKeys(): string[] {
  const { current, previous } = ring();
  return [current.masterKey, ...previous.map((key) => key.masterKey)];
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
    return `${name} contains only ${distinct} distinct character(s)`;
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
      return `${name} repeats the pattern "${unit}"`;
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
  ring();
  return masterKeyWeakness(process.env.MASTER_KEY);
}

/** Resets the memorized keys. Reserved to tests. */
export function resetKeyCache(): void {
  cachedRing = null;
}

export function encrypt(plaintext: string): string {
  const { current } = ring();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, current.key, iv, { authTagLength: AUTH_TAG_LENGTH });
  // The version and the key go into the authenticated data: impossible to
  // downgrade a `v2` to `v1`, or to relabel its key, without invalidating the tag.
  cipher.setAAD(Buffer.from(`${CURRENT_CRYPTO_VERSION}:${current.id}`, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [
    CURRENT_CRYPTO_VERSION,
    current.id,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/** What an encrypted value says of itself, without decrypting it. */
export type EncryptionKeyInfo =
  | { version: 'v2'; keyId: string }
  /** The first format: its key is not written in it. */
  | { version: 'v1' }
  | { version: 'unknown' };

export function encryptionKeyOf(payload: string): EncryptionKeyInfo {
  const parts = payload.split(':');
  if (parts.length === 5 && parts[0] === CURRENT_CRYPTO_VERSION) {
    return { version: 'v2', keyId: parts[1] as string };
  }
  if (parts.length === 4 && parts[0] === LEGACY_CRYPTO_VERSION) return { version: 'v1' };
  return { version: 'unknown' };
}

/** Is the value encrypted with the current key, in the current format? */
export function isOnCurrentKey(payload: string): boolean {
  const info = encryptionKeyOf(payload);
  return info.version === 'v2' && info.keyId === ring().current.id;
}

/** The same value, encrypted again with the current key. */
export function reencrypt(payload: string): string {
  return encrypt(decrypt(payload));
}

export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts[0] === CURRENT_CRYPTO_VERSION && parts.length === 5) {
    const [, keyId, ivB64, tagB64, dataB64] = parts as [string, string, string, string, string];
    const { current, previous } = ring();
    const key = [current, ...previous].find((candidate) => candidate.id === keyId);
    if (!key) {
      throw new DecryptionError(
        `Encrypted with key ${keyId}, which is neither MASTER_KEY nor one of MASTER_KEY_PREVIOUS`,
      );
    }
    return decryptWith(key.key, `${CURRENT_CRYPTO_VERSION}:${keyId}`, ivB64, tagB64, dataB64);
  }
  if (parts[0] === LEGACY_CRYPTO_VERSION && parts.length === 4) {
    const [version, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
    // The first format does not name its key: the current one, then the previous ones.
    const { current, previous } = ring();
    let failure: unknown = null;
    for (const key of [current, ...previous]) {
      try {
        return decryptWith(key.key, version, ivB64, tagB64, dataB64);
      } catch (error) {
        failure = error;
      }
    }
    throw failure as Error;
  }
  if (parts.length !== 4 && parts.length !== 5) {
    throw new DecryptionError(
      `Expected format "version:keyId:iv:authTag:ciphertext", ${parts.length} field(s) received`,
    );
  }
  throw new DecryptionError(`Unknown encryption version "${parts[0] ?? ''}"`);
}

function decryptWith(
  key: Buffer,
  aad: string,
  ivB64: string,
  tagB64: string,
  dataB64: string,
): string {
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');

  if (iv.byteLength !== IV_LENGTH) {
    throw new DecryptionError(`IV of ${iv.byteLength} bytes, ${IV_LENGTH} expected`);
  }
  if (authTag.byteLength !== AUTH_TAG_LENGTH) {
    throw new DecryptionError(
      `Authentication tag of ${authTag.byteLength} bytes, ${AUTH_TAG_LENGTH} expected`,
    );
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // `final()` fails as soon as the tag does not match: tampering with the
    // ciphertext, the IV, the tag, or decryption with another key.
    throw new DecryptionError(
      'Decryption failed: data tampered with, or encrypted with a key that is neither ' +
        'MASTER_KEY nor one of MASTER_KEY_PREVIOUS',
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
