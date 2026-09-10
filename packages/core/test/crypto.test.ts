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

    it('supporte l’unicode, le vide et les charges longues', () => {
      for (const value of ['', 'é→☃', 'a'.repeat(100_000), '{"json":true}']) {
        assert.equal(decrypt(encrypt(value)), value);
      }
    });

    it('produit un ciphertext différent à chaque appel (IV aléatoire)', () => {
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

    it('ne laisse pas le clair apparaître dans la sortie', () => {
      const secret = 'motdepasse-tres-reconnaissable';
      assert.ok(!encrypt(secret).includes(secret));
    });
  });

  describe('détection d’altération', () => {
    /** Retourne le payload avec le champ `index` modifié d’un octet. */
    function tamper(payload: string, index: number): string {
      const parts = payload.split(':');
      const buf = Buffer.from(parts[index] ?? '', 'base64');
      buf[0] = (buf[0] ?? 0) ^ 0xff;
      parts[index] = buf.toString('base64');
      return parts.join(':');
    }

    it('rejette un ciphertext altéré', () => {
      assert.throws(() => decrypt(tamper(encrypt('secret'), 3)), DecryptionError);
    });

    it('rejette un IV altéré', () => {
      assert.throws(() => decrypt(tamper(encrypt('secret'), 1)), DecryptionError);
    });

    it('rejette un tag d’authentification altéré', () => {
      assert.throws(() => decrypt(tamper(encrypt('secret'), 2)), DecryptionError);
    });

    it('rejette une version rétrogradée', () => {
      const payload = encrypt('secret').split(':');
      payload[0] = 'v0';
      assert.throws(() => decrypt(payload.join(':')), DecryptionError);
    });

    it('rejette un nombre de champs incorrect', () => {
      for (const bad of ['', 'v1', 'v1:a:b', 'v1:a:b:c:d']) {
        assert.throws(() => decrypt(bad), DecryptionError);
      }
    });

    it('rejette un IV ou un tag de mauvaise taille', () => {
      const parts = encrypt('secret').split(':');
      const shortIv = [parts[0], Buffer.alloc(8).toString('base64'), parts[2], parts[3]].join(':');
      assert.throws(() => decrypt(shortIv), DecryptionError);
      const shortTag = [parts[0], parts[1], Buffer.alloc(8).toString('base64'), parts[3]].join(':');
      assert.throws(() => decrypt(shortTag), DecryptionError);
    });

    it('rejette une valeur chiffrée avec une autre MASTER_KEY', () => {
      const payload = encrypt('secret');
      withMasterKey(OTHER_HEX_KEY);
      assert.throws(() => decrypt(payload), DecryptionError);
    });
  });

  describe('validation de MASTER_KEY', () => {
    it('refuse une clé absente', () => {
      assert.throws(() => deriveKey(undefined), MasterKeyError);
      assert.throws(() => deriveKey(''), MasterKeyError);
    });

    it('refuse une clé de moins de 32 octets', () => {
      assert.throws(() => deriveKey('trop-court'), MasterKeyError);
      assert.throws(() => deriveKey('a'.repeat(31)), MasterKeyError);
    });

    it('accepte 64 caractères hexadécimaux', () => {
      assert.equal(deriveKey(VALID_HEX_KEY).byteLength, 32);
    });

    it('accepte une phrase secrète d’au moins 32 octets', () => {
      assert.equal(deriveKey('a'.repeat(32)).byteLength, 32);
    });

    it('dérive la même clé pour la même MASTER_KEY, une autre sinon', () => {
      assert.deepEqual(deriveKey(VALID_HEX_KEY), deriveKey(VALID_HEX_KEY));
      assert.notDeepEqual(deriveKey(VALID_HEX_KEY), deriveKey(OTHER_HEX_KEY));
    });

    it('encrypt() échoue si MASTER_KEY est absente', () => {
      withMasterKey(undefined);
      assert.throws(() => encrypt('secret'), MasterKeyError);
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
