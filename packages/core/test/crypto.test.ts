import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  CURRENT_CRYPTO_VERSION,
  DecryptionError,
  MasterKeyError,
  decrypt,
  deriveKey,
  encrypt,
  masterKeyWeakness,
  secretWeakness,
  resetKeyCache,
  safeEqual,
} from '../src/crypto.js';

const VALID_HEX_KEY = randomBytes(32).toString('hex');
const OTHER_HEX_KEY = randomBytes(32).toString('hex');

function withMasterKey(key: string | undefined): void {
  if (key === undefined) {
    delete process.env.MASTER_KEY;
  } else {
    process.env.MASTER_KEY = key;
  }
  resetKeyCache();
}

describe('crypto', () => {
  const original = process.env.MASTER_KEY;

  beforeEach(() => withMasterKey(VALID_HEX_KEY));
  afterEach(() => withMasterKey(original));

  describe('round-trip', () => {
    it('rend le texte d’origine', () => {
      const secret = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 clé de test';
      assert.equal(decrypt(encrypt(secret)), secret);
    });

    it('handles unicode, empty and long payloads', () => {
      for (const value of ['', 'é→☃', 'a'.repeat(100_000), '{"json":true}']) {
        assert.equal(decrypt(encrypt(value)), value);
      }
    });

    it('produces a different ciphertext at each call (random IV)', () => {
      const a = encrypt('même secret');
      const b = encrypt('même secret');
      assert.notEqual(a, b);
      assert.equal(decrypt(a), decrypt(b));
    });

    it('respecte le format version:iv:authTag:ciphertext', () => {
      const parts = encrypt('x').split(':');
      assert.equal(parts.length, 4);
      assert.equal(parts[0], CURRENT_CRYPTO_VERSION);
      assert.equal(Buffer.from(parts[1] ?? '', 'base64').byteLength, 12);
      assert.equal(Buffer.from(parts[2] ?? '', 'base64').byteLength, 16);
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

    it('rejette un nombre de champs incorrect', () => {
      for (const bad of ['', 'v1', 'v1:a:b', 'v1:a:b:c:d']) {
        assert.throws(() => decrypt(bad), DecryptionError);
      }
    });

    it('rejects an IV or a tag of the wrong size', () => {
      const parts = encrypt('secret').split(':');
      const shortIv = [parts[0], Buffer.alloc(8).toString('base64'), parts[2], parts[3]].join(':');
      assert.throws(() => decrypt(shortIv), DecryptionError);
      const shortTag = [parts[0], parts[1], Buffer.alloc(8).toString('base64'), parts[3]].join(':');
      assert.throws(() => decrypt(shortTag), DecryptionError);
    });

    it('rejects a value encrypted with another MASTER_KEY', () => {
      const payload = encrypt('secret');
      withMasterKey(OTHER_HEX_KEY);
      assert.throws(() => decrypt(payload), DecryptionError);
    });
  });

  describe('validation de MASTER_KEY', () => {
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
      assert.match(masterKeyWeakness(EXAMPLE_PASSPHRASE) ?? '', /répète le motif/);
      assert.match(masterKeyWeakness('secret'.repeat(6)) ?? '', /répète le motif/);
    });

    it('flags a key with one or two distinct characters', () => {
      assert.match(masterKeyWeakness('f'.repeat(64)) ?? '', /caractère\(s\) distinct/);
      assert.match(masterKeyWeakness('ab'.repeat(32)) ?? '', /caractère\(s\) distinct/);
    });

    it('lets a real key through', () => {
      assert.equal(masterKeyWeakness(VALID_HEX_KEY), null);
      assert.equal(masterKeyWeakness(OTHER_HEX_KEY), null);
      assert.equal(masterKeyWeakness(randomBytes(32).toString('hex')), null);
      assert.equal(masterKeyWeakness('une-passphrase-honnete-et-assez-longue'), null);
    });

    it('judges the Better Auth secret the same way, by its name', () => {
      assert.match(
        secretWeakness('change-me-change-me-change-me-change-me', 'BETTER_AUTH_SECRET') ?? '',
        /^BETTER_AUTH_SECRET répète le motif « change-me- »/,
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
    it('compare sans fuite de longueur ni faux positif', () => {
      assert.ok(safeEqual('jeton', 'jeton'));
      assert.ok(!safeEqual('jeton', 'jetoN'));
      assert.ok(!safeEqual('jeton', 'jetons'));
      assert.ok(!safeEqual('', 'x'));
      assert.ok(safeEqual('', ''));
    });
  });
});
