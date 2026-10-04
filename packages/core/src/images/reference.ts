/**
 * An image reference, as a `docker pull` understands it.
 *
 * `nginx`, `nginx:1.27`, `bitnami/redis`, `ghcr.io/acme/api:2.1`,
 * `localhost:5000/app`, `postgres:16@sha256:…` — all come down to a registry, a
 * repository, a tag and maybe a digest. The rules are Docker's
 * (`distribution/reference`): they are what both runtimes apply when they pull
 * the image, and the update check must query exactly the same place.
 */

export type ImageReference = {
  /** The registry host, as queried: `registry-1.docker.io`, `ghcr.io`. */
  registry: string;
  /** The repository's path in that registry: `library/nginx`, `acme/api`. */
  repository: string;
  tag: string;
  /** `sha256:…` when the reference pins a precise content. */
  digest: string | null;
};

const DOCKER_HUB = 'registry-1.docker.io';

/** What Docker Hub accepts as host names for itself. */
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

  // The tag is after the last ":" — unless that ":" belongs to a registry's port
  // (`localhost:5000/app`), in which case a "/" follows it.
  let tag = 'latest';
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) return null;
  }

  // The first segment is a registry if it looks like a host: a dot, a port, or
  // `localhost`. Otherwise it is a Docker Hub account (`bitnami/redis`).
  const parts = rest.split('/');
  let registry = DOCKER_HUB;
  const first = parts[0] ?? '';
  if (parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = DOCKER_HUB_ALIASES.has(first) ? DOCKER_HUB : first;
    parts.shift();
  }
  if (parts.length === 0 || !parts.every((part) => PATH_COMPONENT.test(part))) return null;

  // Docker Hub stores its official images under `library/`.
  if (registry === DOCKER_HUB && parts.length === 1) parts.unshift('library');

  return { registry, repository: parts.join('/'), tag, digest };
}

/** The short form, the one a human writes: `nginx:1.27`, `ghcr.io/acme/api:2.1`. */
export function formatImageReference(ref: ImageReference): string {
  const repository =
    ref.registry === DOCKER_HUB
      ? ref.repository.replace(/^library\//, '')
      : `${ref.registry}/${ref.repository}`;
  return `${repository}:${ref.tag}${ref.digest ? `@${ref.digest}` : ''}`;
}

/**
 * The complete form, the one containerd records and the only one it recognizes:
 * `docker.io/library/nginx:1.27`, `docker.io/acme/api:2`, `ghcr.io/acme/api:2.1`,
 * `docker.io/library/postgres@sha256:…`. Docker accepts the short form; some
 * tools that read containerd do not. An unreadable reference is returned as is.
 */
export function canonicalImageReference(raw: string): string {
  const ref = parseImageReference(raw);
  if (ref === null) return raw;
  const host = ref.registry === DOCKER_HUB ? 'docker.io' : ref.registry;
  return ref.digest
    ? `${host}/${ref.repository}@${ref.digest}`
    : `${host}/${ref.repository}:${ref.tag}`;
}

/**
 * Extracts the digest from a form reported by a runtime: `nginx@sha256:…`
 * (Docker, `RepoDigests`), `docker.io/library/nginx@sha256:…` (containerd,
 * `imageID`), or a bare `sha256:…`.
 */
export function digestOf(value: string): string | null {
  const at = value.lastIndexOf('@');
  const candidate = at >= 0 ? value.slice(at + 1) : value;
  return DIGEST.test(candidate) ? candidate : null;
}

/** `sha256:df221db836e1…` → `df221db836e1`, for display. */
export function shortDigest(digest: string | null): string | null {
  if (!digest) return null;
  return digest.replace(/^sha256:/, '').slice(0, 12);
}
