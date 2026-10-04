import { createHash } from 'node:crypto';
import type { ImageReference } from './reference.js';

/**
 * What a registry says about an image, without downloading it.
 *
 * ── Two questions, two requests ──────────────────────────────────────────────
 * "Which content does the tag designate today?": a `HEAD` on the manifest, whose
 * `Docker-Content-Digest` header is the answer. The `HEAD` downloads nothing and
 * does not count toward Docker Hub's quota (checked: `ratelimit-remaining` does
 * not move). "Is there a more recent tag?": the list of tags, paginated,
 * bounded.
 *
 * The requested digest is that of the multi-architecture **index** when it
 * exists — hence the `Accept` header that lists it first. It is also the one
 * both runtimes keep after a pull by tag (`RepoDigests` on the Docker side,
 * `imageID` on the containerd side), measured on both: the comparison is
 * therefore made on equal footing.
 *
 * ── Authentication ───────────────────────────────────────────────────────────
 * Anonymous, through the standard challenge: a 401 announces in
 * `WWW-Authenticate` where to ask for a token and for which scope. A private
 * image answers 401 even afterwards — it is a "cannot be checked", not a panel
 * error.
 *
 * ── What this client refuses ────────────────────────────────────────────────
 * The registry comes from an AppSpec, and the token server from the registry's
 * response: two addresses the panel does not choose. Only HTTPS is followed, for
 * either; a clear-text registry is not queried.
 */

export type RegistryErrorCode =
  'unauthorized' | 'not_found' | 'rate_limited' | 'unreachable' | 'unexpected';

export class RegistryError extends Error {
  constructor(
    readonly code: RegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

export type RegistryClientOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Pages of a thousand tags at most, for a repository that counts thousands. */
  maxTagPages?: number;
  userAgent?: string;
};

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

type Challenge = { realm: string; service: string | null; scope: string | null };

/** `Bearer realm="https://…",service="…",scope="…"` → its parameters. */
export function parseBearerChallenge(header: string | null): Challenge | null {
  if (!header || !/^bearer\s/i.test(header)) return null;
  const params = new Map<string, string>();
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) {
    params.set(match[1]!.toLowerCase(), match[2]!);
  }
  const realm = params.get('realm');
  if (!realm) return null;
  return { realm, service: params.get('service') ?? null, scope: params.get('scope') ?? null };
}

/** `</v2/…/tags/list?last=x&n=1000>; rel="next"` → the next URL, relative to the registry. */
export function nextPage(link: string | null): string | null {
  if (!link) return null;
  const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(link);
  return match?.[1] ?? null;
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function createRegistryClient(options: RegistryClientOptions = {}) {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxTagPages = options.maxTagPages ?? 5;
  const userAgent = options.userAgent ?? 'pupitre-image-check';
  const tokens = new Map<string, string>();

  async function call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, {
        ...init,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': userAgent, ...(init.headers as Record<string, string>) },
      });
    } catch (error) {
      throw new RegistryError(
        'unreachable',
        error instanceof Error ? error.message : 'registre injoignable',
      );
    }
  }

  async function token(challenge: Challenge): Promise<string> {
    const key = `${challenge.realm}|${challenge.service ?? ''}|${challenge.scope ?? ''}`;
    const cached = tokens.get(key);
    if (cached) return cached;
    if (!isHttps(challenge.realm)) {
      throw new RegistryError('unexpected', `serveur de jetons non HTTPS : ${challenge.realm}`);
    }
    const url = new URL(challenge.realm);
    if (challenge.service) url.searchParams.set('service', challenge.service);
    if (challenge.scope) url.searchParams.set('scope', challenge.scope);
    const response = await call(url.toString(), { method: 'GET' });
    if (!response.ok) {
      throw new RegistryError('unauthorized', `token refused (HTTP ${response.status})`);
    }
    const body = (await response.json().catch(() => ({}))) as {
      token?: string;
      access_token?: string;
    };
    const value = body.token ?? body.access_token;
    if (!value) throw new RegistryError('unauthorized', 'no token in the response');
    tokens.set(key, value);
    return value;
  }

  /** A request to the registry, with the authentication challenge if needed. */
  async function request(
    ref: ImageReference,
    path: string,
    init: RequestInit & { headers?: Record<string, string> },
  ): Promise<Response> {
    const url = `https://${ref.registry}${path}`;
    let response = await call(url, init);
    if (response.status === 401) {
      const challenge = parseBearerChallenge(response.headers.get('www-authenticate'));
      if (!challenge) throw new RegistryError('unauthorized', 'access refused by the registry');
      // Without an announced scope (HEAD on some registries), we infer it.
      const scoped = challenge.scope
        ? challenge
        : { ...challenge, scope: `repository:${ref.repository}:pull` };
      const bearer = await token(scoped);
      response = await call(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${bearer}` },
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new RegistryError('unauthorized', 'private image or access refused');
    }
    if (response.status === 404)
      throw new RegistryError('not_found', 'tag or repository not found');
    if (response.status === 429) throw new RegistryError('rate_limited', 'registry quota reached');
    if (!response.ok) {
      throw new RegistryError('unexpected', `unexpected response (HTTP ${response.status})`);
    }
    return response;
  }

  return {
    /** The digest the tag designates today, on the registry side. */
    async manifestDigest(ref: ImageReference): Promise<string> {
      const path = `/v2/${ref.repository}/manifests/${ref.tag}`;
      const headers = { accept: MANIFEST_ACCEPT };
      const head = await request(ref, path, { method: 'HEAD', headers });
      const announced = head.headers.get('docker-content-digest');
      if (announced && /^sha256:[a-f0-9]{64}$/.test(announced)) return announced;

      // A few registries announce nothing on a HEAD: a manifest's digest is the
      // SHA-256 of its bytes, as served.
      const body = await (await request(ref, path, { method: 'GET', headers })).arrayBuffer();
      return `sha256:${createHash('sha256').update(Buffer.from(body)).digest('hex')}`;
    },

    /** The repository's tags, page by page, within the set limit. */
    async listTags(ref: ImageReference): Promise<string[]> {
      const tags: string[] = [];
      let path: string | null = `/v2/${ref.repository}/tags/list?n=1000`;
      for (let page = 0; path && page < maxTagPages; page += 1) {
        const response: Response = await request(ref, path, { method: 'GET' });
        const body = (await response.json().catch(() => ({}))) as { tags?: unknown };
        if (Array.isArray(body.tags)) {
          tags.push(...body.tags.filter((tag): tag is string => typeof tag === 'string'));
        }
        const next = nextPage(response.headers.get('link'));
        // A next page does not leave the queried registry.
        path = next && next.startsWith('/v2/') ? next : null;
      }
      return tags;
    },
  };
}

export type RegistryClient = ReturnType<typeof createRegistryClient>;
