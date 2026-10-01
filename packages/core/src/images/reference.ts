/**
 * Une référence d'image, telle qu'un `docker pull` la comprend.
 *
 * `nginx`, `nginx:1.27`, `bitnami/redis`, `ghcr.io/acme/api:2.1`,
 * `localhost:5000/app`, `postgres:16@sha256:…` — toutes se ramènent à un
 * registre, un dépôt, un tag et peut-être un digest. Les règles sont celles de
 * Docker (`distribution/reference`) : c'est elles que les deux runtimes
 * appliquent quand ils tirent l'image, et la vérification des mises à jour doit
 * interroger exactement le même endroit.
 */

export type ImageReference = {
  /** Hôte du registre, tel qu'on l'interroge : `registry-1.docker.io`, `ghcr.io`. */
  registry: string;
  /** Chemin du dépôt dans ce registre : `library/nginx`, `acme/api`. */
  repository: string;
  tag: string;
  /** `sha256:…` quand la référence épingle un contenu précis. */
  digest: string | null;
};

const DOCKER_HUB = 'registry-1.docker.io';

/** Ce que Docker Hub accepte comme noms d'hôte pour lui-même. */
const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TAG = /^[\w][\w.-]{0,127}$/;
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

export function parseImageReference(raw: string): ImageReference | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 512 || /\s/.test(value)) return null;

  let rest = value;
  let digest: string | null = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) return null;
  }

  // Le tag est après le dernier « : » — sauf si ce « : » appartient au port
  // d'un registre (`localhost:5000/app`), auquel cas un « / » le suit.
  let tag = 'latest';
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) return null;
  }

  // Le premier segment est un registre s'il ressemble à un hôte : un point, un
  // port, ou `localhost`. Sinon c'est un compte Docker Hub (`bitnami/redis`).
  const parts = rest.split('/');
  let registry = DOCKER_HUB;
  const first = parts[0] ?? '';
  if (parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = DOCKER_HUB_ALIASES.has(first) ? DOCKER_HUB : first;
    parts.shift();
  }
  if (parts.length === 0 || !parts.every((part) => PATH_COMPONENT.test(part))) return null;

  // Docker Hub range ses images officielles sous `library/`.
  if (registry === DOCKER_HUB && parts.length === 1) parts.unshift('library');

  return { registry, repository: parts.join('/'), tag, digest };
}

/** La forme courte, celle qu'un humain écrit : `nginx:1.27`, `ghcr.io/acme/api:2.1`. */
export function formatImageReference(ref: ImageReference): string {
  const repository =
    ref.registry === DOCKER_HUB
      ? ref.repository.replace(/^library\//, '')
      : `${ref.registry}/${ref.repository}`;
  return `${repository}:${ref.tag}${ref.digest ? `@${ref.digest}` : ''}`;
}

/**
 * Extrait le digest d'une forme rapportée par un runtime :
 * `nginx@sha256:…` (Docker, `RepoDigests`), `docker.io/library/nginx@sha256:…`
 * (containerd, `imageID`), ou `sha256:…` nu.
 */
export function digestOf(value: string): string | null {
  const at = value.lastIndexOf('@');
  const candidate = at >= 0 ? value.slice(at + 1) : value;
  return DIGEST.test(candidate) ? candidate : null;
}

/** `sha256:df221db836e1…` → `df221db836e1`, pour l'affichage. */
export function shortDigest(digest: string | null): string | null {
  if (!digest) return null;
  return digest.replace(/^sha256:/, '').slice(0, 12);
}
