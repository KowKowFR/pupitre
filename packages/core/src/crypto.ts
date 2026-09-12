import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Chiffrement symétrique des secrets stockés en base (credentials SSH au
 * jalon 3, tokens divers ensuite).
 *
 * Format de sortie : `version:iv:authTag:ciphertext`
 * Les trois derniers champs sont en base64 — l'alphabet base64 ne contient
 * pas de `:`, le découpage est donc sans ambiguïté.
 *
 * Le préfixe de version permettra une rotation de clé : une future `v2`
 * cohabitera avec les valeurs `v1` déjà en base, et `decrypt()` choisira
 * l'algorithme d'après le préfixe.
 */

export const CURRENT_CRYPTO_VERSION = 'v1' as const;

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, taille recommandée pour GCM
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256
const MIN_MASTER_KEY_BYTES = 32;

/** Contexte HKDF : fige le domaine d'usage de la clé dérivée. */
const HKDF_SALT = 'bootstrap-tp-v2/secret-encryption';
const HKDF_INFO = 'aes-256-gcm/v1';

/** `MASTER_KEY` absente, trop courte ou illisible. */
export class MasterKeyError extends Error {
  override readonly name = 'MasterKeyError';
}

/** Valeur chiffrée corrompue, tronquée, altérée ou chiffrée avec une autre clé. */
export class DecryptionError extends Error {
  override readonly name = 'DecryptionError';
}

/**
 * Matériau de clé brut.
 * `openssl rand -hex 32` produit 64 caractères hexadécimaux, décodés en
 * 32 octets. Toute autre chaîne est prise telle quelle et doit peser au
 * moins 32 octets.
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
 * Valide `MASTER_KEY` et retourne la clé dérivée.
 * Appelée au démarrage du panel et du worker : l'application refuse de
 * démarrer avec une clé absente ou trop faible.
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

let cachedKey: Buffer | null = null;

function activeKey(): Buffer {
  cachedKey ??= deriveKey(process.env.MASTER_KEY);
  return cachedKey;
}

/**
 * La clé est-elle valide mais notoirement devinable ?
 *
 * `deriveKey()` ne vérifie qu'une **longueur**, et soixante-quatre zéros font
 * trente-deux octets tout comme une vraie clé. Le `.env.example` livre
 * précisément cette valeur, et une instance montée en recopiant l'exemple
 * chiffre donc ses identifiants SSH sous une clé publiée. Elle démarre, elle
 * déchiffre, tous les tests passent — le défaut est invisible par construction,
 * et c'est bien pour cela qu'il faut le dire à voix haute.
 *
 * On ne refuse pas de démarrer : la base contient déjà des valeurs chiffrées
 * sous cette clé, et une instance qui ne démarre plus est une instance dont on
 * ne peut plus sortir les identifiants pour les rechiffrer. On avertit, et la
 * rotation reste une décision de l'exploitant.
 *
 * Le critère est la **forme**, pas une liste d'exemples à tenir à jour : une
 * clé tirée au sort n'a jamais un seul caractère distinct, ni un motif court
 * répété. Aucune vraie clé ne tombe dans ce filet.
 */
export function masterKeyWeakness(masterKey: string | undefined): string | null {
  if (masterKey === undefined || masterKey === '') return null;

  const distinct = new Set(masterKey).size;
  if (distinct <= 2) {
    return `MASTER_KEY ne contient que ${distinct} caractère(s) distinct(s)`;
  }

  // Un motif de 15 caractères ou moins, répété jusqu'au bout : c'est la forme
  // des exemples, jamais celle d'un tirage.
  //
  // La répétition n'a pas à tomber juste : la phrase de passe du `.env.example`
  // fait 39 caractères pour un motif de 10, sa dernière occurrence est tronquée.
  // Exiger une division exacte laissait donc passer la valeur même de l'exemple,
  // ce que le premier jet a fait.
  for (let size = 1; size <= 15 && size * 2 <= masterKey.length; size += 1) {
    const unit = masterKey.slice(0, size);
    const tiled = unit.repeat(Math.ceil(masterKey.length / size)).slice(0, masterKey.length);
    if (tiled === masterKey) {
      return `MASTER_KEY répète le motif « ${unit} »`;
    }
  }

  return null;
}

/**
 * Vérifie `MASTER_KEY` au démarrage et met la clé dérivée en cache.
 * À appeler une fois au boot, avant de servir la moindre requête.
 *
 * Rend la raison pour laquelle la clé est faible, ou `null`. L'appelant décide
 * quoi en faire — ici on ne sait pas encore avec quel journal on écrit.
 */
export function assertMasterKey(): string | null {
  activeKey();
  return masterKeyWeakness(process.env.MASTER_KEY);
}

/** Réinitialise la clé mémorisée. Réservé aux tests. */
export function resetKeyCache(): void {
  cachedKey = null;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, activeKey(), iv, { authTagLength: AUTH_TAG_LENGTH });
  // La version entre dans les données authentifiées : impossible de
  // rétrograder une `v2` en `v1` sans invalider le tag.
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
    // `final()` échoue dès que le tag ne correspond pas : altération du
    // ciphertext, de l'IV, du tag, ou déchiffrement avec une autre clé.
    throw new DecryptionError(
      'Déchiffrement impossible : donnée altérée ou chiffrée avec une autre MASTER_KEY',
    );
  }
}

/** Comparaison à temps constant, pour les jetons et empreintes. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.byteLength !== bufB.byteLength) return false;
  return timingSafeEqual(bufA, bufB);
}
