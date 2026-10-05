/**
 * Does a commit concern this application?
 *
 * In a monorepo, each application watches its paths: its folder, plus what it
 * shares (`packages/shared/**`). Without this filter, fixing the documentation
 * would redeploy the whole repository. The spec file is always watched:
 * modifying it is modifying the application.
 *
 * Three pattern shapes, the only ones we need:
 *   — `**`: the whole repository;
 *   — `folder/**`, or plain `folder`: that folder and everything it contains;
 *   — a pattern with `*` (one segment) or `**` (several): `apps/*\/Dockerfile`.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(path: string): string {
  return path.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '');
}

/** A pattern as a regular expression, anchored at both ends. */
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

/** True as soon as a modified file falls under a watched path — or is the spec. */
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
 * The paths watched by default: the spec's folder, or the whole repository when
 * the spec is at the root.
 */
export function defaultWatchPaths(specPath: string): string[] {
  const spec = normalize(specPath);
  const directory = spec.includes('/') ? spec.slice(0, spec.lastIndexOf('/')) : '';
  return [directory === '' ? '**' : `${directory}/**`];
}
