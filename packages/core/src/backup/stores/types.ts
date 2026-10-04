import type { Readable } from 'node:stream';
import type { BackupDestinationKind } from '../destinations.js';

/**
 * The contract of a backup destination. It is all the worker knows of it: place
 * a stream under a key, read it back, delete it, list. Adding a destination
 * means adding a class that respects it.
 *
 * Keys are relative paths (`apps/blog/2026-…/manifest.json.pupb`), always with
 * `/`; each destination places them under its prefix.
 */
export type StoredObject = { key: string; bytes: number; modifiedAt: string | null };

export interface BackupStore {
  readonly kind: BackupDestinationKind;
  /** Writes, reads back and deletes a witness file: is the destination usable? */
  check(): Promise<void>;
  /** Places the stream under the key; returns the number of bytes written. */
  put(key: string, body: Readable): Promise<number>;
  get(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
  /** Deletes everything that starts with this prefix; returns the number of files deleted. */
  removePrefix(prefix: string): Promise<number>;
  list(prefix: string): Promise<StoredObject[]>;
  close(): Promise<void>;
}

export class BackupStoreError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BackupStoreError';
  }
}

/** A witness file name, under the destination's prefix. */
export function probeKey(): string {
  return `.pupitre-check-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
