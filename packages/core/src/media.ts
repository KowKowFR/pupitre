import { z } from 'zod';

/**
 * Les images que des personnes déposent dans le panel : une photo de profil,
 * une image dans la discussion.
 *
 * ── Pourquoi lire les octets plutôt que croire l'en-tête ────────────────────
 * Le navigateur dit `image/png`, le nom de fichier dit `.jpg` : ni l'un ni
 * l'autre n'engage rien. Ce module lit la signature et les dimensions dans les
 * premiers octets, et c'est **ce type-là** qui est stocké et resservi. Un
 * fichier qui ne se reconnaît pas comme l'un des quatre formats est refusé.
 *
 * ── Pourquoi pas de SVG ─────────────────────────────────────────────────────
 * Un SVG est un document, scripts compris. Servi depuis l'origine du panel, ce
 * serait du XSS stocké à la portée de quiconque peut écrire dans la discussion.
 *
 * ── Pourquoi le redimensionnement est fait par le navigateur ───────────────
 * Le panel n'embarque aucune bibliothèque d'image native (pas de `sharp` dans
 * l'image Docker). Le navigateur recadre et réencode avant l'envoi — ce qui
 * retire au passage les métadonnées EXIF, position GPS comprise. Le serveur, lui,
 * ne fait confiance à rien : il borne la taille, lit le format et les dimensions.
 */

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const imageMediaTypeSchema = z.enum(IMAGE_MEDIA_TYPES);
export type ImageMediaType = z.infer<typeof imageMediaTypeSchema>;

/** Une photo de profil : un carré, réencodé par le navigateur. */
export const AVATAR_EDGE = 256;
export const AVATAR_MAX_BYTES = 512 * 1024;
export const AVATAR_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
];

/** Une image de la discussion : le plus grand côté borné, quatre par message. */
export const CHAT_IMAGE_MAX_EDGE = 1920;
export const CHAT_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
export const CHAT_IMAGES_PER_MESSAGE = 4;

/** Au-delà, une image n'est plus une image : c'est une bombe de décompression. */
const MAX_DIMENSION = 12_000;

export type ImageInfo = { contentType: ImageMediaType; width: number; height: number };

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => u16le(b, i) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, i: number) => ((u16be(b, i) << 16) >>> 0) + u16be(b, i + 2);
const ascii = (b: Uint8Array, i: number, length: number) =>
  String.fromCharCode(...b.subarray(i, i + length));

function png(b: Uint8Array): ImageInfo | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, index) => b[index] === byte) || ascii(b, 12, 4) !== 'IHDR') {
    return null;
  }
  return { contentType: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
}

function gif(b: Uint8Array): ImageInfo | null {
  const header = ascii(b, 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return null;
  return { contentType: 'image/gif', width: u16le(b, 6), height: u16le(b, 8) };
}

function webp(b: Uint8Array): ImageInfo | null {
  if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X') {
    return { contentType: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    const [b0, b1, b2, b3] = [b[21] ?? 0, b[22] ?? 0, b[23] ?? 0, b[24] ?? 0];
    return {
      contentType: 'image/webp',
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return {
      contentType: 'image/webp',
      width: u16le(b, 26) & 0x3fff,
      height: u16le(b, 28) & 0x3fff,
    };
  }
  return null;
}

/** Les marqueurs SOF portent les dimensions ; DHT, JPG et DAC partagent leur plage sans en être. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(b: Uint8Array): ImageInfo | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let index = 2;
  while (index + 9 < b.length) {
    if (b[index] !== 0xff) return null;
    const marker = b[index + 1] ?? 0;
    // Bourrage, et marqueurs sans segment (RSTn, TEM).
    if (marker === 0xff) {
      index += 1;
      continue;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      index += 2;
      continue;
    }
    if (SOF.has(marker)) {
      return { contentType: 'image/jpeg', height: u16be(b, index + 5), width: u16be(b, index + 7) };
    }
    const length = u16be(b, index + 2);
    if (length < 2) return null;
    index += 2 + length;
  }
  return null;
}

/**
 * Le format et les dimensions d'une image, lus dans ses octets. `null` si ce
 * n'est pas l'un des quatre formats acceptés, ou si ses dimensions sont
 * absurdes.
 */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 26) return null;
  const info = png(bytes) ?? jpeg(bytes) ?? webp(bytes) ?? gif(bytes);
  if (!info) return null;
  if (info.width < 1 || info.height < 1) return null;
  if (info.width > MAX_DIMENSION || info.height > MAX_DIMENSION) return null;
  return info;
}

/**
 * Les en-têtes d'une image servie depuis l'origine du panel. Elle est rendue,
 * jamais interprétée : pas de sniffing, pas de script, pas de navigation.
 */
export function imageResponseHeaders(input: {
  contentType: ImageMediaType;
  bytes: number;
  filename: string;
  /** Une URL versionnée ne change jamais de contenu : elle se garde un an. */
  immutable: boolean;
}): Record<string, string> {
  return {
    'content-type': input.contentType,
    'content-length': String(input.bytes),
    'cache-control': input.immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'content-disposition': `inline; filename="${input.filename.replace(/[^\w.-]/g, '_')}"`,
  };
}

/** `image/webp` → `webp`, pour un nom de fichier. */
export function imageExtension(contentType: ImageMediaType): string {
  return contentType === 'image/jpeg' ? 'jpg' : contentType.slice('image/'.length);
}

/**
 * L'URL d'une photo de profil, si — et seulement si — c'est l'une des nôtres.
 *
 * `users.image` est un champ de Better Auth, que son API laisse modifier par
 * son titulaire. Afficher n'importe quelle URL qui s'y trouverait ferait
 * charger à chaque membre de l'équipe une image hébergée ailleurs — un pixel
 * espion, au minimum. Seule la forme que le panel écrit lui-même passe.
 */
const AVATAR_URL = /^\/api\/users\/[\w-]{1,64}\/avatar\?v=[a-f0-9]{12}$/;

export function avatarSrc(image: string | null | undefined): string | null {
  return image && AVATAR_URL.test(image) ? image : null;
}
