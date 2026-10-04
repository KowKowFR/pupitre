import { z } from 'zod';

/**
 * The images people upload into the panel: a profile picture, an image in the
 * chat.
 *
 * ── Why read the bytes rather than trust the header ─────────────────────────
 * The browser says `image/png`, the file name says `.jpg`: neither commits to
 * anything. This module reads the signature and the dimensions in the first
 * bytes, and it is **that type** that is stored and served again. A file that is
 * not recognized as one of the four formats is refused.
 *
 * ── Why no SVG ──────────────────────────────────────────────────────────────
 * An SVG is a document, scripts included. Served from the panel's origin, it
 * would be stored XSS within reach of anyone who can write in the chat.
 *
 * ── Why resizing is done by the browser ────────────────────────────────────
 * The panel ships no native image library (no `sharp` in the Docker image). The
 * browser crops and re-encodes before sending — which removes EXIF metadata
 * along the way, GPS position included. The server trusts nothing: it caps the
 * size, reads the format and the dimensions.
 */

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const imageMediaTypeSchema = z.enum(IMAGE_MEDIA_TYPES);
export type ImageMediaType = z.infer<typeof imageMediaTypeSchema>;

/** A profile picture: a square, re-encoded by the browser. */
export const AVATAR_EDGE = 256;
export const AVATAR_MAX_BYTES = 512 * 1024;
export const AVATAR_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
];

/** A chat image: the longest side capped, four per message. */
export const CHAT_IMAGE_MAX_EDGE = 1920;
export const CHAT_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
export const CHAT_IMAGES_PER_MESSAGE = 4;

/** Beyond this, an image is no longer an image: it is a decompression bomb. */
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

/** SOF markers carry the dimensions; DHT, JPG and DAC share their range without being ones. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(b: Uint8Array): ImageInfo | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let index = 2;
  while (index + 9 < b.length) {
    if (b[index] !== 0xff) return null;
    const marker = b[index + 1] ?? 0;
    // Padding, and markers without a segment (RSTn, TEM).
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
 * An image's format and dimensions, read from its bytes. `null` if it is not one
 * of the four accepted formats, or if its dimensions are absurd.
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
 * The headers of an image served from the panel's origin. It is rendered, never
 * interpreted: no sniffing, no script, no navigation.
 */
export function imageResponseHeaders(input: {
  contentType: ImageMediaType;
  bytes: number;
  filename: string;
  /** A versioned URL never changes content: it is kept for a year. */
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

/** `image/webp` → `webp`, for a file name. */
export function imageExtension(contentType: ImageMediaType): string {
  return contentType === 'image/jpeg' ? 'jpg' : contentType.slice('image/'.length);
}

/**
 * A profile picture's URL, if — and only if — it is one of ours.
 *
 * `users.image` is a Better Auth field, which its API lets its holder change.
 * Showing any URL that might be found there would make each team member load
 * an image hosted elsewhere — a tracking pixel, at the very least. Only the
 * shape the panel writes itself gets through.
 */
const AVATAR_URL = /^\/api\/users\/[\w-]{1,64}\/avatar\?v=[a-f0-9]{12}$/;

export function avatarSrc(image: string | null | undefined): string | null {
  return image && AVATAR_URL.test(image) ? image : null;
}
