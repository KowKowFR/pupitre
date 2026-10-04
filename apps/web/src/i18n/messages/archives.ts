import type { Translated } from '@pupitre/core';

/**
 * Le code téléversé d'une application : la carte de sa fiche, et les erreurs
 * des routes qui reçoivent, listent et effacent les archives — et de celles
 * qui déploient, quand le code manque.
 *
 * `.tar.gz`, `.git/`, `Dockerfile` et `SHA-256` ne se traduisent pas : ce sont
 * des noms de fichiers et de formats.
 */
const fr = {
  // ── La carte ────────────────────────────────────────────────────────────
  'card.title': 'Code de l’application',
  'card.description':
    'Une archive .tar.gz ou .zip du code : les services qui se construisent depuis un Dockerfile la prennent pour contexte. Elle n’apporte que le code — l’AppSpec reste celle du panel.',
  'card.noBuild':
    'Aucun service ne se construit depuis un Dockerfile : une archive ne servira que lorsque l’AppSpec en déclarera un.',
  'card.empty':
    'Aucune archive pour l’instant : téléversez le code avant de déployer un service qui se construit.',
  'upload.button': 'Téléverser',
  'upload.hint':
    '.tar.gz, .tgz, .tar ou .zip, {max} au plus. Les dossiers .git/ et __MACOSX/ sont écartés, comme les fichiers que macOS ajoute (._*, .DS_Store).',
  'upload.drop': 'Déposez l’archive ici',
  'upload.progress': 'Envoi de « {name} »… {percent} %',
  'upload.done': 'Archive reçue : vérification en cours.',
  'upload.failed': 'Envoi impossible : {error}',
  'upload.tooLarge': 'Archive trop volumineuse : {max} au plus.',
  'status.receiving': 'réception',
  'status.pending': 'vérification…',
  'status.ready': 'prête',
  'status.rejected': 'refusée',
  'current.label': 'Code actuel',
  'meta.files': { one: '{count} fichier', other: '{count} fichiers' },
  'meta.unpacked': '{size} décompressée',
  'meta.by': 'envoyée par {name}, {ago}',
  'meta.anonymous': 'envoyée {ago}',
  'meta.stripped': 'dossier de tête « {root}/ » retiré',
  'meta.skipped': {
    one: '{count} entrée écartée (.git/, __MACOSX/, fichiers de macOS)',
    other: '{count} entrées écartées (.git/, __MACOSX/, fichiers de macOS)',
  },
  'meta.sha': 'SHA-256 de l’envoi',
  'meta.pending': 'Le worker relit l’archive entrée par entrée ; la carte se met à jour seule.',
  'checks.title': 'Ce que chaque service construit',
  'check.found': 'trouvé',
  'check.missing': 'absent de l’archive',
  'check.unknown': 'vérifié à la construction',
  'history.title': 'Versions précédentes',
  'history.kept':
    'Pupitre garde les {count} dernières archives : de quoi redéployer une version récente.',
  'delete.label': 'Supprimer l’archive « {name} »',
  'delete.title': 'Supprimer « {name} » ?',
  'delete.body':
    'Ses octets sont effacés du panel. Une version qui l’a construite ne pourra plus être redéployée ; ce qui tourne n’est pas touché.',
  'delete.confirm': 'Supprimer',
  'delete.done': 'Archive supprimée',
  'delete.failed': 'Suppression impossible : {error}',

  // ── Pourquoi une archive est refusée (codes du worker) ──────────────────
  'reject.format': 'Format non reconnu : seuls .tar.gz, .tar et .zip sont acceptés.',
  'reject.corrupt': 'Archive illisible : {detail}',
  'reject.encrypted': 'Une entrée chiffrée : {detail}',
  'reject.empty': 'Archive vide, une fois .git/, __MACOSX/ et les fichiers de macOS écartés.',
  'reject.too_many_entries': 'Trop d’entrées : {detail} au plus.',
  'reject.too_large': 'Trop volumineuse une fois décompressée : {detail} au plus.',
  'reject.absolute_path': 'Un chemin absolu : {detail}',
  'reject.parent_path': 'Un chemin qui remonte hors de l’archive : {detail}',
  'reject.invalid_name': 'Un nom invalide : {detail}',
  'reject.link_outside': 'Un lien qui pointe hors du code : {detail}',
  'reject.link_traversal': 'Une entrée écrite à travers un lien de l’archive : {detail}',
  'reject.hardlink': 'Un lien dur : {detail}',
  'reject.special_file': 'Un fichier spécial (périphérique, tube) : {detail}',
  'reject.duplicate': 'Deux entrées au même chemin : {detail}',

  // ── Erreurs des routes ──────────────────────────────────────────────────
  'error.notFound': 'Application {id} introuvable',
  'error.archiveNotFound': 'Archive {id} introuvable',
  'error.linked':
    'Le code de cette application vient de son dépôt lié : une archive téléversée n’y servirait pas.',
  'error.format': 'Format non reconnu : envoyez une archive .tar.gz, .tar ou .zip.',
  'error.empty': 'Rien reçu : le corps de la requête doit être l’archive elle-même.',
  'error.inFlight':
    'Un déploiement en cours construit cette archive : elle se supprimera une fois ce déploiement terminé.',
  'error.enqueueFailed': 'Impossible de mettre la vérification de l’archive en file.',
  'deploy.none':
    'Le service « {service} » se construit depuis un Dockerfile : téléversez le code de l’application (carte « Code de l’application »), ou liez-la à un dépôt.',
  'deploy.pending':
    'L’archive « {name} » est en cours de vérification : réessayez dans un instant.',
  'deploy.rejected':
    'La dernière archive téléversée, « {name} », a été refusée : téléversez-en une autre.',
  'deploy.dockerfile':
    'Le service « {service} » se construit depuis {path}, absent de l’archive « {name} ».',
  'redeploy.gone':
    'L’archive « {name} » de cette version n’est plus conservée — Pupitre garde les {count} dernières de chaque application.',
} as const;

const en: Translated<typeof fr> = {
  'card.title': 'Application code',
  'card.description':
    'A .tar.gz or .zip archive of the code: services built from a Dockerfile use it as their context. It only brings the code — the AppSpec stays the panel’s.',
  'card.noBuild':
    'No service is built from a Dockerfile: an archive will only be used once the AppSpec declares one.',
  'card.empty': 'No archive yet: upload the code before deploying a service that gets built.',
  'upload.button': 'Upload',
  'upload.hint':
    '.tar.gz, .tgz, .tar or .zip, {max} at most. .git/ and __MACOSX/ folders are left out, as are the files macOS adds (._*, .DS_Store).',
  'upload.drop': 'Drop the archive here',
  'upload.progress': 'Uploading “{name}”… {percent}%',
  'upload.done': 'Archive received: being checked.',
  'upload.failed': 'Upload failed: {error}',
  'upload.tooLarge': 'Archive too large: {max} at most.',
  'status.receiving': 'receiving',
  'status.pending': 'checking…',
  'status.ready': 'ready',
  'status.rejected': 'rejected',
  'current.label': 'Current code',
  'meta.files': { one: '{count} file', other: '{count} files' },
  'meta.unpacked': '{size} unpacked',
  'meta.by': 'uploaded by {name}, {ago}',
  'meta.anonymous': 'uploaded {ago}',
  'meta.stripped': 'top folder “{root}/” removed',
  'meta.skipped': {
    one: '{count} entry left out (.git/, __MACOSX/, macOS files)',
    other: '{count} entries left out (.git/, __MACOSX/, macOS files)',
  },
  'meta.sha': 'SHA-256 of the upload',
  'meta.pending': 'The worker reads the archive entry by entry; this card updates on its own.',
  'checks.title': 'What each built service needs',
  'check.found': 'found',
  'check.missing': 'missing from the archive',
  'check.unknown': 'checked at build time',
  'history.title': 'Previous versions',
  'history.kept': 'Pupitre keeps the last {count} archives: enough to redeploy a recent version.',
  'delete.label': 'Delete the “{name}” archive',
  'delete.title': 'Delete “{name}”?',
  'delete.body':
    'Its bytes are erased from the panel. A version built from it can no longer be redeployed; what is running is not touched.',
  'delete.confirm': 'Delete',
  'delete.done': 'Archive deleted',
  'delete.failed': 'Could not delete: {error}',

  'reject.format': 'Unrecognised format: only .tar.gz, .tar and .zip are accepted.',
  'reject.corrupt': 'Unreadable archive: {detail}',
  'reject.encrypted': 'An encrypted entry: {detail}',
  'reject.empty': 'Empty archive, once .git/, __MACOSX/ and macOS files are left out.',
  'reject.too_many_entries': 'Too many entries: {detail} at most.',
  'reject.too_large': 'Too large once unpacked: {detail} at most.',
  'reject.absolute_path': 'An absolute path: {detail}',
  'reject.parent_path': 'A path climbing out of the archive: {detail}',
  'reject.invalid_name': 'An invalid name: {detail}',
  'reject.link_outside': 'A link pointing outside the code: {detail}',
  'reject.link_traversal': 'An entry written through a link of the archive: {detail}',
  'reject.hardlink': 'A hard link: {detail}',
  'reject.special_file': 'A special file (device, pipe): {detail}',
  'reject.duplicate': 'Two entries at the same path: {detail}',

  'error.notFound': 'Application {id} not found',
  'error.archiveNotFound': 'Archive {id} not found',
  'error.linked':
    'This application’s code comes from its linked repository: an uploaded archive would not be used.',
  'error.format': 'Unrecognised format: send a .tar.gz, .tar or .zip archive.',
  'error.empty': 'Nothing received: the request body must be the archive itself.',
  'error.inFlight':
    'A running deployment is building this archive: it can be deleted once that deployment ends.',
  'error.enqueueFailed': 'Could not queue the archive check.',
  'deploy.none':
    'Service “{service}” is built from a Dockerfile: upload the application’s code (“Application code” card), or link it to a repository.',
  'deploy.pending': 'Archive “{name}” is being checked: try again in a moment.',
  'deploy.rejected': 'The latest uploaded archive, “{name}”, was rejected: upload another one.',
  'deploy.dockerfile':
    'Service “{service}” is built from {path}, which is missing from archive “{name}”.',
  'redeploy.gone':
    'Archive “{name}” of this version is no longer kept — Pupitre keeps the last {count} of each application.',
};

export const archives = { fr, en };
