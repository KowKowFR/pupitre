import { createHash } from 'node:crypto';
import type { ImageReference } from './reference.js';

/**
 * Ce qu'un registre dit d'une image, sans la télécharger.
 *
 * ── Deux questions, deux requêtes ────────────────────────────────────────────
 * « Quel contenu le tag désigne-t-il aujourd'hui ? » : un `HEAD` sur le
 * manifeste, dont l'en-tête `Docker-Content-Digest` est la réponse. Le `HEAD`
 * ne télécharge rien et ne compte pas dans le quota de Docker Hub (vérifié :
 * `ratelimit-remaining` ne bouge pas). « Existe-t-il un tag plus récent ? » :
 * la liste des tags, paginée, bornée.
 *
 * Le digest demandé est celui de l'**index** multi-architecture quand il
 * existe — d'où l'en-tête `Accept` qui le cite en premier. C'est aussi celui que
 * les deux runtimes retiennent après un pull par tag (`RepoDigests` côté
 * Docker, `imageID` côté containerd), mesuré sur les deux : la comparaison se
 * fait donc à forme égale.
 *
 * ── Authentification ─────────────────────────────────────────────────────────
 * Anonyme, par le défi standard : un 401 annonce dans `WWW-Authenticate` où
 * demander un jeton et pour quelle portée. Une image privée répond 401 même
 * après — c'est un « non vérifiable », pas une erreur du panel.
 *
 * ── Ce que ce client refuse ─────────────────────────────────────────────────
 * Le registre vient d'une AppSpec, et le serveur de jetons de la réponse du
 * registre : deux adresses que le panel ne choisit pas. Seul HTTPS est suivi,
 * pour l'un comme pour l'autre ; un registre en clair n'est pas interrogé.
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
  /** Pages de mille tags au plus, pour un dépôt qui en compte des milliers. */
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

/** `Bearer realm="https://…",service="…",scope="…"` → ses paramètres. */
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

/** `</v2/…/tags/list?last=x&n=1000>; rel="next"` → l'URL suivante, relative au registre. */
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
      throw new RegistryError('unauthorized', `jeton refusé (HTTP ${response.status})`);
    }
    const body = (await response.json().catch(() => ({}))) as {
      token?: string;
      access_token?: string;
    };
    const value = body.token ?? body.access_token;
    if (!value) throw new RegistryError('unauthorized', 'jeton absent de la réponse');
    tokens.set(key, value);
    return value;
  }

  /** Une requête au registre, avec le défi d'authentification si besoin. */
  async function request(
    ref: ImageReference,
    path: string,
    init: RequestInit & { headers?: Record<string, string> },
  ): Promise<Response> {
    const url = `https://${ref.registry}${path}`;
    let response = await call(url, init);
    if (response.status === 401) {
      const challenge = parseBearerChallenge(response.headers.get('www-authenticate'));
      if (!challenge) throw new RegistryError('unauthorized', 'accès refusé par le registre');
      // Sans portée annoncée (HEAD sur certains registres), on la déduit.
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
      throw new RegistryError('unauthorized', 'image privée ou accès refusé');
    }
    if (response.status === 404) throw new RegistryError('not_found', 'tag ou dépôt introuvable');
    if (response.status === 429)
      throw new RegistryError('rate_limited', 'quota du registre atteint');
    if (!response.ok) {
      throw new RegistryError('unexpected', `réponse inattendue (HTTP ${response.status})`);
    }
    return response;
  }

  return {
    /** Le digest que le tag désigne aujourd'hui, côté registre. */
    async manifestDigest(ref: ImageReference): Promise<string> {
      const path = `/v2/${ref.repository}/manifests/${ref.tag}`;
      const headers = { accept: MANIFEST_ACCEPT };
      const head = await request(ref, path, { method: 'HEAD', headers });
      const announced = head.headers.get('docker-content-digest');
      if (announced && /^sha256:[a-f0-9]{64}$/.test(announced)) return announced;

      // Quelques registres n'annoncent rien sur un HEAD : le digest d'un
      // manifeste est le SHA-256 de ses octets, tels que servis.
      const body = await (await request(ref, path, { method: 'GET', headers })).arrayBuffer();
      return `sha256:${createHash('sha256').update(Buffer.from(body)).digest('hex')}`;
    },

    /** Les tags du dépôt, page par page, dans la limite fixée. */
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
        // Une page suivante ne quitte pas le registre interrogé.
        path = next && next.startsWith('/v2/') ? next : null;
      }
      return tags;
    },
  };
}

export type RegistryClient = ReturnType<typeof createRegistryClient>;
