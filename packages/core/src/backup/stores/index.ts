import type { BackupDestinationKind, ResolvedBackupDestination } from '../destinations.js';
import type { UiLanguage } from '../../i18n.js';
import { LocalBackupStore } from './local.js';
import { S3BackupStore } from './s3.js';
import { SftpBackupStore } from './sftp.js';
import type { BackupStore } from './types.js';

export * from './types.js';
export { S3BackupStore } from './s3.js';
export { SftpBackupStore } from './sftp.js';
export { LocalBackupStore } from './local.js';
export { signV4, encodeKeyPath, encodeRfc3986, canonicalQuery, sha256Hex } from './sigv4.js';

type Factory<K extends BackupDestinationKind> = (
  destination: Extract<ResolvedBackupDestination, { kind: K }>,
  language: UiLanguage,
) => BackupStore;

/** Une destination de plus, c'est une classe et une ligne ici — rien d'autre ne bouge. */
const STORES: { [K in BackupDestinationKind]: Factory<K> } = {
  s3: (destination, language) =>
    new S3BackupStore(destination.config, destination.secrets, fetch, language),
  sftp: (destination, language) =>
    new SftpBackupStore(destination.config, destination.secrets, language),
  local: (destination, language) => new LocalBackupStore(destination.config, language),
};

/** `language` : celle de ce que la destination dit d'un échec — l'instance. */
export function openBackupStore(
  destination: ResolvedBackupDestination,
  language: UiLanguage = 'fr',
): BackupStore {
  const factory = STORES[destination.kind] as Factory<typeof destination.kind>;
  return factory(destination as never, language);
}
