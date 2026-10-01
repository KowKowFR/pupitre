import type { Readable } from 'node:stream';
import type { BackupDestinationKind } from '../destinations.js';

/**
 * Le contrat d'une destination de sauvegarde. Le worker n'en connaît que ça :
 * déposer un flux sous une clé, le relire, l'effacer, lister. Ajouter une
 * destination, c'est ajouter une classe qui le respecte.
 *
 * Les clés sont des chemins relatifs (`apps/blog/2026-…/manifest.json.pupb`),
 * toujours avec `/` ; chaque destination les place sous son préfixe.
 */
export type StoredObject = { key: string; bytes: number; modifiedAt: string | null };

export interface BackupStore {
  readonly kind: BackupDestinationKind;
  /** Écrit, relit et efface un fichier témoin : la destination est-elle utilisable ? */
  check(): Promise<void>;
  /** Dépose le flux sous la clé ; rend le nombre d'octets écrits. */
  put(key: string, body: Readable): Promise<number>;
  get(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
  /** Efface tout ce qui commence par ce préfixe ; rend le nombre de fichiers effacés. */
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

/** Un nom de fichier témoin, sous le préfixe de la destination. */
export function probeKey(): string {
  return `.pupitre-check-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
