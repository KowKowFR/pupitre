/**
 * Un commit concerne-t-il cette application ?
 *
 * Dans un monorepo, chaque application surveille ses chemins : son dossier,
 * plus ce qu'elle partage (`packages/shared/**`). Sans ce filtre, corriger la
 * documentation redéploierait tout le dépôt. Le fichier de spec est toujours
 * surveillé : le modifier, c'est modifier l'application.
 *
 * Trois formes de motif, les seules dont on a besoin :
 *   — `**` : tout le dépôt ;
 *   — `dossier/**`, ou `dossier` tout court : ce dossier et tout ce qu'il contient ;
 *   — un motif avec `*` (un segment) ou `**` (plusieurs) : `apps/*\/Dockerfile`.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(path: string): string {
  return path.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '');
}

/** Un motif en expression régulière, ancrée aux deux bouts. */
function patternToRegExp(pattern: string): RegExp {
  const source = normalize(pattern)
    .split('**')
    .map((part) => part.split('*').map(escapeRegExp).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

export function matchesWatchPath(file: string, pattern: string): boolean {
  const path = normalize(file);
  const motif = normalize(pattern);
  if (motif === '' || motif === '**') return true;
  if (!motif.includes('*')) return path === motif || path.startsWith(`${motif}/`);
  return patternToRegExp(motif).test(path);
}

/** Vrai dès qu'un fichier modifié tombe sous un chemin surveillé — ou est la spec. */
export function touchesWatchPaths(
  files: readonly string[],
  watchPaths: readonly string[],
  specPath: string,
): boolean {
  const spec = normalize(specPath);
  return files.some(
    (file) =>
      normalize(file) === spec || watchPaths.some((pattern) => matchesWatchPath(file, pattern)),
  );
}

/**
 * Les chemins surveillés par défaut : le dossier de la spec, ou tout le dépôt
 * quand la spec est à la racine.
 */
export function defaultWatchPaths(specPath: string): string[] {
  const spec = normalize(specPath);
  const directory = spec.includes('/') ? spec.slice(0, spec.lastIndexOf('/')) : '';
  return [directory === '' ? '**' : `${directory}/**`];
}
