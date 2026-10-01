import { AVATAR_EDGE, CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MAX_EDGE } from '@pupitre/core';

/**
 * Préparer une image **dans le navigateur**, avant l'envoi.
 *
 * Le panel n'embarque aucune bibliothèque d'image côté serveur : c'est ici que
 * l'on recadre, réduit et réencode. Le réencodage a un second effet, voulu :
 * une image passée par un `<canvas>` perd ses métadonnées EXIF — la position
 * GPS d'une photo de téléphone ne part donc jamais dans la base.
 *
 * Le serveur, lui, ne fait confiance à rien de tout cela : il relit le format
 * et les dimensions dans les octets reçus.
 */

export class ImagePrepError extends Error {
  constructor(readonly code: 'unreadable' | 'too_large') {
    super(code);
    this.name = 'ImagePrepError';
  }
}

/** Décode une image. L'orientation EXIF est appliquée par le navigateur. */
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
    // L'image décodée garde ses pixels ; l'URL ne sert plus.
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * WebP d'abord ; un navigateur qui ne sait pas l'encoder rend du PNG à la
 * place, et l'on s'en contente s'il tient dans la borne. Sinon, JPEG — sur fond
 * blanc, puisque le JPEG n'a pas de transparence.
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

/** La zone retenue d'une image, en pixels de l'image : un carré pour une photo de profil. */
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
 * Une image pour la discussion : le plus grand côté ramené à 1920 px,
 * réencodée. Un GIF qui tient dans la borne passe tel quel — le réencoder lui
 * ferait perdre son animation.
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

/** `image/webp` → `webp`, pour nommer un fichier envoyé. */
export function extensionOf(blob: Blob): string {
  const subtype = blob.type.split('/')[1] ?? 'bin';
  return subtype === 'jpeg' ? 'jpg' : subtype;
}
