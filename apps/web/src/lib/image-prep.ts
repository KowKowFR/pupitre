import { AVATAR_EDGE, CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MAX_EDGE } from '@pupitre/core';

/**
 * Preparing an image **in the browser**, before uploading.
 *
 * The panel embeds no image library on the server side: it is here that one
 * crops, reduces and re-encodes. Re-encoding has a second, intended effect: an
 * image that went through a `<canvas>` loses its EXIF metadata — a phone
 * picture's GPS position therefore never goes into the database.
 *
 * The server, for its part, trusts none of that: it reads the format and the
 * dimensions again in the received bytes.
 */

export class ImagePrepError extends Error {
  constructor(readonly code: 'unreadable' | 'too_large') {
    super(code);
    this.name = 'ImagePrepError';
  }
}

/** Decodes an image. The EXIF orientation is applied by the browser. */
export async function loadImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    if (image.naturalWidth < 1 || image.naturalHeight < 1) throw new ImagePrepError('unreadable');
    return image;
  } catch (error) {
    throw error instanceof ImagePrepError ? error : new ImagePrepError('unreadable');
  } finally {
    // The decoded image keeps its pixels; the URL is no longer needed.
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * WebP first; a browser that cannot encode it returns PNG instead, and we settle
 * for it if it fits in the bound. Otherwise, JPEG — on a white background, since
 * JPEG has no transparency.
 */
async function encode(canvas: HTMLCanvasElement, maxBytes: number, quality: number): Promise<Blob> {
  const webp = await toBlob(canvas, 'image/webp', quality);
  if (webp && webp.size <= maxBytes) return webp;

  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height;
  const context = flat.getContext('2d');
  if (!context) throw new ImagePrepError('unreadable');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, flat.width, flat.height);
  context.drawImage(canvas, 0, 0);
  for (const q of [quality, 0.75, 0.6]) {
    const jpeg = await toBlob(flat, 'image/jpeg', q);
    if (jpeg && jpeg.size <= maxBytes) return jpeg;
  }
  throw new ImagePrepError('too_large');
}

/** An image's kept area, in the image's pixels: a square for a profile picture. */
export type CropSquare = { x: number; y: number; size: number };

export async function cropAvatar(image: HTMLImageElement, crop: CropSquare): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_EDGE;
  canvas.height = AVATAR_EDGE;
  const context = canvas.getContext('2d');
  if (!context) throw new ImagePrepError('unreadable');
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, AVATAR_EDGE, AVATAR_EDGE);
  return encode(canvas, 512 * 1024, 0.9);
}

export type PreparedImage = { blob: Blob; width: number; height: number };

/**
 * An image for the chat: the longest side brought down to 1920 px, re-encoded. A
 * GIF that fits in the bound goes through as is — re-encoding it would lose its
 * animation.
 */
export async function prepareChatImage(file: File): Promise<PreparedImage> {
  const image = await loadImage(file);
  const { naturalWidth: width, naturalHeight: height } = image;

  if (file.type === 'image/gif' && file.size <= CHAT_IMAGE_MAX_BYTES) {
    return { blob: file, width, height };
  }

  const scale = Math.min(1, CHAT_IMAGE_MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new ImagePrepError('unreadable');
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await encode(canvas, CHAT_IMAGE_MAX_BYTES, 0.85);
  return { blob, width: canvas.width, height: canvas.height };
}

/** `image/webp` → `webp`, to name an uploaded file. */
export function extensionOf(blob: Blob): string {
  const subtype = blob.type.split('/')[1] ?? 'bin';
  return subtype === 'jpeg' ? 'jpg' : subtype;
}
