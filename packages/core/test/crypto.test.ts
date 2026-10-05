import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  CURRENT_CRYPTO_VERSION,
  DecryptionError,
  MasterKeyError,
  currentKeyId,
  decrypt,
  deriveKey,
  encrypt,
  encryptionKeyOf,
  isOnCurrentKey,
  keyIdOf,
  previousKeyIds,
  reencrypt,
  masterKeyWeakness,
  secretWeakness,
  resetKeyCache,
  safeEqual,
} from '../src/crypto.js';

const VALID_HEX_KEY = randomBytes(32).toString('hex');
const OTHER_HEX_KEY = randomBytes(32).toString('hex');

function withMasterKey(key: string | undefined, previous?: string): void {
  if (key === undefined) {
    delete process.env.MASTER_KEY;
  } else {
    process.env.MASTER_KEY = key;
  }
  if (previous === undefined) {
    delete process.env.MASTER_KEY_PREVIOUS;
  } else {
    process.env.MASTER_KEY_PREVIOUS = previous;
  }
  resetKeyCache();
}

/** A value in the first format, `v1:iv:authTag:ciphertext`, as the panel wrote them before rotation. */
function legacyEncrypt(plaintext: string, masterKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(masterKey), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from('v1', 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    data.toString('base64'),
  ].join(':');
}

describe('crypto', () => {
  const original = process.env.MASTER_KEY;

  beforeEach(() => withMasterKey(VALID_HEX_KEY));
  afterEach(() => withMasterKey(original));

  describe('round-trip', () => {
    it('returns the original text', () => {
      const secret = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 test key';
      assert.equal(decrypt(encrypt(secret)), secret);
    });

    it('handles unicode, empty and long payloads', () => {
      for (const value of ['', 'é→☃', 'a'.repeat(100_000), '{"json":true}']) {
        assert.equal(decrypt(encrypt(value)), value);
      }
    });

    it('produces a different ciphertext at each call (random IV)', () => {
      const a = encrypt('same secret');
      const b = encrypt('same secret');
      assert.notEqual(a, b);
      assert.equal(decrypt(a), decrypt(b));
    });

    it('follows the v2:keyId:iv:authTag:ciphertext format', () => {
      const parts = encrypt('x').split(':');
      assert.equal(parts.length, 5);
      assert.equal(parts[0], CURRENT_CRYPTO_VERSION);
      assert.equal(parts[1], keyIdOf(VALID_HEX_KEY));
      assert.match(parts[1] ?? '', /^[0-9a-f]{8}$/);
      assert.equal(Buffer.from(parts[2] ?? '', 'base64').byteLength, 12);
      assert.equal(Buffer.from(parts[3] ?? '', 'base64').byteLength, 16);
    });

    it('does not let the plaintext appear in the output', () => {
      const secret = 'motdepasse-tres-reconnaissable';
      assert.ok(!encrypt(secret).includes(secret));
    });
  });

  describe('tamper detection', () => {
    /** Returns the payload with the `index` field changed by one byte. */
    function tamper(payload: string, index: number): string {
      const parts = payload.split(':');
      const buf = Buffer.from(parts[index] ?? '', 'base64');
      buf[0] = (buf[0] ?? 0) ^ 0xff;
      parts[index] = buf.toString('base64');
      return parts.join(':');
    }

    it('rejects a tampered ciphertext', () => {
      assert.throws(() => decrypt(tamper(encrypt('secret'), 3)), DecryptionError);
    });

    it('rejects a tampered IV', () => {
      assert.throws(() => decrypt(tamper(encrypt('secret'), 1)), DecryptionError);
    });

    it('rejects a tampered authentication tag', () => {
      assert.throws(() => decrypt(tamper(encrypt('secret'), 2)), DecryptionError);
    });

    it('rejects a downgraded version', () => {
      const payload = encrypt('secret').split(':');
      payload[0] = 'v0';
      assert.throws(() => decrypt(payload.join(':')), DecryptionError);
    });

    it('rejects a wrong number of fields', () => {
      for (const bad of ['', 'v1', 'v1:a:b', 'v1:a:b:c:d']) {
        assert.throws(() => decrypt(bad), DecryptionError);
      }
    });

    it('rejects an IV or a tag of the wrong size', () => {
      const parts = encrypt('secret').split(':');
      const short = Buffer.alloc(8).toString('base64');
      const shortIv = [parts[0], parts[1], short, parts[3], parts[4]].join(':');
      assert.throws(() => decrypt(shortIv), DecryptionError);
      const shortTag = [parts[0], parts[1], parts[2], short, parts[4]].join(':');
      assert.throws(() => decrypt(shortTag), DecryptionError);
    });

    it('rejects a value whose key was relabeled', () => {
      withMasterKey(VALID_HEX_KEY, OTHER_HEX_KEY);
      const parts = encrypt('secret').split(':');
      parts[1] = keyIdOf(OTHER_HEX_KEY);
      assert.throws(() => decrypt(parts.join(':')), DecryptionError);
    });

    it('rejects a value encrypted with another MASTER_KEY', () => {
      const payload = encrypt('secret');
      withMasterKey(OTHER_HEX_KEY);
      assert.throws(() => decrypt(payload), DecryptionError);
    });
  });

  describe('rotation', () => {
    it('reads what the previous key encrypted, and encrypts again under the new one', () => {
      const before = encrypt('ssh password');
      assert.equal(isOnCurrentKey(before), true);

      // The operator rotates: the old key moves to MASTER_KEY_PREVIOUS.
      withMasterKey(OTHER_HEX_KEY, VALID_HEX_KEY);
      assert.equal(currentKeyId(), keyIdOf(OTHER_HEX_KEY));
      assert.deepEqual(previousKeyIds(), [keyIdOf(VALID_HEX_KEY)]);
      assert.equal(decrypt(before), 'ssh password');
      assert.equal(isOnCurrentKey(before), false);

      const after = reencrypt(before);
      assert.equal(isOnCurrentKey(after), true);
      assert.deepEqual(encryptionKeyOf(after), { version: 'v2', keyId: keyIdOf(OTHER_HEX_KEY) });

      // Once everything is encrypted again, the old key can go.
      withMasterKey(OTHER_HEX_KEY);
      assert.equal(decrypt(after), 'ssh password');
      assert.throws(() => decrypt(before), /neither MASTER_KEY nor one of MASTER_KEY_PREVIOUS/);
    });

    it('reads the first format, which does not name its key, with each key in turn', () => {
      const legacy = legacyEncrypt('ai key', VALID_HEX_KEY);
      assert.deepEqual(encryptionKeyOf(legacy), { version: 'v1' });
      assert.equal(decrypt(legacy), 'ai key');
      assert.equal(isOnCurrentKey(legacy), false, 'the first format is always rewritten');

      withMasterKey(OTHER_HEX_KEY, VALID_HEX_KEY);
      assert.equal(decrypt(legacy), 'ai key');
      withMasterKey(OTHER_HEX_KEY);
      assert.throws(() => decrypt(legacy), DecryptionError);
    });

    it('ignores a previous key equal to the current one, and several previous keys', () => {
      const third = randomBytes(32).toString('hex');
      withMasterKey(VALID_HEX_KEY, ` ${VALID_HEX_KEY} , ${OTHER_HEX_KEY},${third} `);
      assert.deepEqual(previousKeyIds(), [keyIdOf(OTHER_HEX_KEY), keyIdOf(third)]);
    });

    it('refuses a previous key that is too short, like the current one', () => {
      withMasterKey(VALID_HEX_KEY, 'short');
      assert.throws(() => encrypt('secret'), MasterKeyError);
    });
  });

  describe('MASTER_KEY validation', () => {
    it('refuses a missing key', () => {
      assert.throws(() => deriveKey(undefined), MasterKeyError);
      assert.throws(() => deriveKey(''), MasterKeyError);
    });

    it('refuses a key shorter than 32 bytes', () => {
      assert.throws(() => deriveKey('trop-court'), MasterKeyError);
      assert.throws(() => deriveKey('a'.repeat(31)), MasterKeyError);
    });

    it('accepts 64 hexadecimal characters', () => {
      assert.equal(deriveKey(VALID_HEX_KEY).byteLength, 32);
    });

    it('accepts a passphrase of at least 32 bytes', () => {
      assert.equal(deriveKey('a'.repeat(32)).byteLength, 32);
    });

    it('derives the same key for the same MASTER_KEY, another otherwise', () => {
      assert.deepEqual(deriveKey(VALID_HEX_KEY), deriveKey(VALID_HEX_KEY));
      assert.notDeepEqual(deriveKey(VALID_HEX_KEY), deriveKey(OTHER_HEX_KEY));
    });

    it('encrypt() fails if MASTER_KEY is missing', () => {
      withMasterKey(undefined);
      assert.throws(() => encrypt('secret'), MasterKeyError);
    });
  });

  // A valid key is not necessarily a serious key: sixty-four zeros make
  // thirty-two bytes, and that is exactly what `.env.example` ships. Length says
  // nothing about entropy, and an instance set up by copying the example encrypts
  // its SSH credentials under a published key — without any test flinching, since
  // everything works.
  // The two templates of `.env.example`, assembled rather than copied: these
  // strings serve as clear-text secrets on instances set up identically, and a
  // secret scan of the repository must be able to stay silent.
  const EXAMPLE_HEX_KEY = '0'.repeat(64);
  const EXAMPLE_PASSPHRASE = 'change-me-'.repeat(4).slice(0, 39);

  describe('detecting a guessable MASTER_KEY', () => {
    it('flags the .env.example values, as is', () => {
      assert.ok(masterKeyWeakness(EXAMPLE_HEX_KEY));
      assert.ok(masterKeyWeakness(EXAMPLE_PASSPHRASE));
    });

    it('flags a repeated pattern that does not fall exactly', () => {
      // 39 characters for a 10-character pattern: requiring an exact division would
      // let the example's own value through.
      assert.equal(EXAMPLE_PASSPHRASE.length % 10, 9);
      assert.match(masterKeyWeakness(EXAMPLE_PASSPHRASE) ?? '', /repeats the pattern/);
      assert.match(masterKeyWeakness('secret'.repeat(6)) ?? '', /repeats the pattern/);
    });

    it('flags a key with one or two distinct characters', () => {
      assert.match(masterKeyWeakness('f'.repeat(64)) ?? '', /distinct character\(s\)/);
      assert.match(masterKeyWeakness('ab'.repeat(32)) ?? '', /distinct character\(s\)/);
    });

    it('lets a real key through', () => {
      assert.equal(masterKeyWeakness(VALID_HEX_KEY), null);
      assert.equal(masterKeyWeakness(OTHER_HEX_KEY), null);
      assert.equal(masterKeyWeakness(randomBytes(32).toString('hex')), null);
      assert.equal(masterKeyWeakness('an-honest-and-long-enough-passphrase'), null);
    });

    it('judges the Better Auth secret the same way, by its name', () => {
      assert.match(
        secretWeakness('change-me-change-me-change-me-change-me', 'BETTER_AUTH_SECRET') ?? '',
        /^BETTER_AUTH_SECRET repeats the pattern "change-me-"/,
      );
      assert.equal(secretWeakness(randomBytes(32).toString('base64'), 'BETTER_AUTH_SECRET'), null);
      assert.equal(secretWeakness(undefined, 'BETTER_AUTH_SECRET'), null);
    });

    it('says nothing about a missing key — it is not its subject', () => {
      assert.equal(masterKeyWeakness(undefined), null);
      assert.equal(masterKeyWeakness(''), null);
    });
  });

  describe('safeEqual', () => {
    it('compares without length leak or false positive', () => {
      assert.ok(safeEqual('jeton', 'jeton'));
      assert.ok(!safeEqual('jeton', 'jetoN'));
      assert.ok(!safeEqual('jeton', 'jetons'));
      assert.ok(!safeEqual('', 'x'));
      assert.ok(safeEqual('', ''));
    });
  });
});
