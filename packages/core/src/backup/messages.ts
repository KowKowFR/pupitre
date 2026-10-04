import { translator, type Translate, type Translated, type UiLanguage } from '../i18n.js';

/**
 * What the backup destinations and the encrypted format say — a destination's
 * "Test", a backup's or a restore's failure —, in the instance's language.
 */
const fr = {
  'store.keyOutside': 'clé hors du dossier de sauvegarde : {key}',
  'store.writeFailed': 'écriture de « {key} » impossible — {error}',
  'store.localMissing':
    "le dossier {path} n'existe pas dans le conteneur du worker — montez-y le partage",
  'store.probeMismatch': 'le fichier témoin relu ne correspond pas',
  's3.noUploadId': 'S3 : envoi multipartie refusé (pas d’UploadId)',
  's3.noEtag': 'S3 : partie envoyée sans ETag',
  's3.assembleRefused': 'S3 : assemblage refusé — {detail}',
  's3.probeMismatch': 'S3 : le fichier témoin relu ne correspond pas',
  'sftp.hostKey': "SFTP : la clé d'hôte de {host} ne correspond pas ({presented}) — refus",
  'sftp.connectFailed': 'SFTP : connexion impossible à {host}:{port} — {detail}',
  'sftp.writeFailed': 'SFTP : écriture de « {key} » impossible — {error}',
  'sftp.probeMismatch': 'SFTP : le fichier témoin relu ne correspond pas',
  'format.truncated': 'fichier de sauvegarde tronqué',
  'format.authFailed':
    'authentification impossible : fichier altéré, ou chiffré sous une autre MASTER_KEY',
} as const;

const en: Translated<typeof fr> = {
  'store.keyOutside': 'key outside the backup folder: {key}',
  'store.writeFailed': 'writing “{key}” failed — {error}',
  'store.localMissing':
    'folder {path} does not exist in the worker container — mount the share there',
  'store.probeMismatch': 'the probe file read back does not match',
  's3.noUploadId': 'S3: multipart upload refused (no UploadId)',
  's3.noEtag': 'S3: part sent without an ETag',
  's3.assembleRefused': 'S3: assembly refused — {detail}',
  's3.probeMismatch': 'S3: the probe file read back does not match',
  'sftp.hostKey': 'SFTP: the host key of {host} does not match ({presented}) — refused',
  'sftp.connectFailed': 'SFTP: cannot connect to {host}:{port} — {detail}',
  'sftp.writeFailed': 'SFTP: writing “{key}” failed — {error}',
  'sftp.probeMismatch': 'SFTP: the probe file read back does not match',
  'format.truncated': 'truncated backup file',
  'format.authFailed': 'authentication failed: file altered, or encrypted under another MASTER_KEY',
};

export const backupCopy = { fr, en };

export type BackupSay = Translate<typeof fr>;

export function backupSay(language: UiLanguage): BackupSay {
  return translator(backupCopy, language);
}
