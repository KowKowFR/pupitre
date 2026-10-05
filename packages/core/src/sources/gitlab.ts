import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UiLanguage } from '../i18n.js';
import { sourceSay } from './messages.js';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { assertEgressAllowed, EgressRefusedError } from '../egress.js';
import {
  SourceProviderError,
  type CommitStatus,
  type CompareResult,
  type HeadResult,
  type RepositoryRef,
  type SourceCommit,
  type SourceProvider,
  type SourceRepository,
} from './types.js';

/**
 * GitLab — gitlab.com ou une instance auto-hébergée, par l'API v4 et un
 * **jeton d'accès** : de préférence un jeton de projet ou de groupe, rôle
 * Maintainer, portée `api`.
 *
 * `api` est large, mais GitLab n'a rien de plus étroit pour écrire l'état d'un
 * déploiement sur un commit — `read_api` lit tout, n'écrit rien. Le rôle
 * aussi : sur une branche protégée, GitLab n'accepte un statut que de qui peut
 * y pousser — Maintainer par défaut ; Developer suffit si les développeurs
 * peuvent pousser sur la branche suivie. Un jeton de projet borne tout cela à
 * un seul projet, un jeton de groupe à ses projets. Il est chiffré en base et
 * ne vit en clair qu'en mémoire, dans ce client.
 *
 * Un dépôt s'y nomme par son chemin complet — `groupe/sous-groupe/projet` — que
 * l'API prend encodé d'un bloc comme identifiant de projet. Comme pour GitHub
 * et Gitea, tout part de Pupitre : aucun webhook, l'instance n'appelle jamais
 * le panel ; le polling compare l'empreinte de la branche au dernier commit vu.
 *
 * L'adresse de l'instance est saisie dans le panel : chaque appel passe la
 * garde des sorties réseau (`assertEgressAllowed`) — un réseau privé est
 * permis, l'adresse des métadonnées d'un cloud ne l'est pas.
 */

type FetchLike = typeof fetch;
/** Un GET, rien de plus : de quoi télécharger une archive. */
type GetLike = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

export type GitLabCredentials = {
  /** L'adresse de l'instance, telle qu'un navigateur l'ouvre : `https://gitlab.com`. */
  baseUrl: string;
  /** Le jeton d'accès. Déchiffré juste avant l'appel, jamais journalisé. */
  token: string;
  /** La langue de ce que le client dit — celle de l'instance. Français par défaut. */
  language?: UiLanguage;
};

/** Au-delà, une comparaison ne se croit plus : on traite tout comme changé. */
const COMPARE_FILE_LIMIT = 300;
/** Le maximum de l'API v4 par page. */
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

const BASE_HEADERS = { accept: 'application/json', 'user-agent': 'pupitre' };

/** `https://gitlab.exemple.fr/` → `https://gitlab.exemple.fr` ; refuse ce qui n'est pas http(s). */
export function gitlabBaseUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SourceProviderError(
      `adresse GitLab en ${url.protocol} : http ou https attendu`,
      null,
      'gitlab',
    );
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/**
 * Un GET par `node:http`, sans les en-têtes qu'ajoute le `fetch` de Node : il
 * pose toujours `sec-fetch-mode: cors`, impossible à retirer, et GitLab
 * refuse l'archive d'un dépôt à une requête qui se dit « cors » (406).
 */
function plainGet(url: string, init: { headers: Record<string, string> }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(target, { method: 'GET', headers: init.headers }, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const status = response.statusCode ?? 502;
      const body =
        status === 204 || status === 304
          ? null
          : (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>);
      resolve(new Response(body, { status, headers }));
    });
    request.on('error', reject);
    request.end();
  });
}

/** `groupe/sous-groupe/projet` → l'identifiant de projet de l'API, encodé d'un bloc. */
function projectId(fullName: string): string {
  return encodeURIComponent(fullName);
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    message?: unknown;
    error?: unknown;
  } | null;
  const raw = body?.message ?? body?.error;
  const message = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : response.statusText;
  return `GitLab ${response.status} : ${message}`;
}

/** L'état d'un commit, dans les mots de GitLab. */
const GITLAB_STATE: Record<CommitStatus['state'], string> = {
  pending: 'pending',
  success: 'success',
  failure: 'failed',
  error: 'failed',
};

type GitLabProject = {
  path_with_namespace: string;
  default_branch: string | null;
  visibility: string;
  web_url: string;
};

type GitLabDiff = {
  old_path: string;
  new_path: string;
  renamed_file?: boolean;
};

export class GitLabSourceProvider implements SourceProvider {
  readonly kind = 'gitlab' as const;
  private readonly apiUrl: string;

  constructor(
    private readonly credentials: GitLabCredentials,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly guard: (url: string) => Promise<void> = assertEgressAllowed,
    /** L'archive seulement : voir `plainGet`. */
    private readonly archiveGet: GetLike = plainGet,
  ) {
    this.apiUrl = `${gitlabBaseUrl(credentials.baseUrl)}/api/v4`;
  }

  private async call(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      /** Par `archiveGet` plutôt que `fetch`. */
      plain?: boolean;
    } = {},
  ): Promise<Response> {
    const url = `${this.apiUrl}${path}`;
    try {
      await this.guard(url);
    } catch (error) {
      if (error instanceof EgressRefusedError) {
        throw new SourceProviderError(
          error.describe(this.credentials.language ?? 'fr'),
          null,
          'gitlab',
        );
      }
      throw error;
    }
    const headers = {
      ...BASE_HEADERS,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
      'private-token': this.credentials.token,
    };
    if (init.plain) return this.archiveGet(url, { headers });
    return this.fetchImpl(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  private async json<T>(response: Response): Promise<T> {
    if (!response.ok) {
      throw new SourceProviderError(await errorMessage(response), response.status, 'gitlab');
    }
    return (await response.json()) as T;
  }

  // ─── SourceProvider ─────────────────────────────────────────────────────────

  async resolveHead(repo: RepositoryRef, branch: string): Promise<HeadResult> {
    const body = await this.json<{ commit?: { id?: string } }>(
      await this.call(
        `/projects/${projectId(repo.fullName)}/repository/branches/${encodeURIComponent(branch)}`,
      ),
    );
    const sha = body.commit?.id ?? '';
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
      throw new SourceProviderError(
        `empreinte de commit illisible : « ${sha.slice(0, 60)} »`,
        null,
        'gitlab',
      );
    }
    // Pas d'ETag : c'est la comparaison au dernier commit vu qui dit « rien de neuf ».
    return { changed: true, sha, etag: null };
  }

  async compare(repo: RepositoryRef, base: string, head: string): Promise<CompareResult> {
    if (base === head) return { kind: 'files', files: [] };
    const response = await this.call(
      `/projects/${projectId(repo.fullName)}/repository/compare?from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}`,
    );
    if (response.status === 404) {
      return { kind: 'unknown', reason: `commit de base ${base.slice(0, 7)} introuvable` };
    }
    const body = await this.json<{
      commits?: Array<{ id: string; parent_ids?: string[] }>;
      diffs?: GitLabDiff[];
      compare_timeout?: boolean;
    }>(response);
    const commits = body.commits ?? [];
    // Rien entre les deux, ou une base qui n'est pas un ancêtre de la tête :
    // l'historique a été réécrit (force-push), la liste ne dit pas tout.
    if (commits.length === 0) return { kind: 'unknown', reason: 'historique réécrit' };
    if (!commits.some((commit) => commit.parent_ids?.includes(base))) {
      return { kind: 'unknown', reason: 'historique divergent' };
    }
    // GitLab a coupé la comparaison à ses limites : la liste est incomplète.
    if (body.compare_timeout) return { kind: 'unknown', reason: 'comparaison tronquée par GitLab' };
    const files = new Set<string>();
    for (const diff of body.diffs ?? []) {
      // Un renommage touche deux chemins : l'ancien et le nouveau.
      if (diff.renamed_file) files.add(diff.old_path);
      files.add(diff.new_path);
    }
    if (files.size >= COMPARE_FILE_LIMIT) {
      return { kind: 'unknown', reason: `plus de ${COMPARE_FILE_LIMIT} fichiers modifiés` };
    }
    return { kind: 'files', files: [...files].sort() };
  }

  async readFile(repo: RepositoryRef, sha: string, path: string): Promise<string | null> {
    // Le chemin du fichier est, lui aussi, encodé d'un bloc : `apps%2Fapi%2Fpupitre.json`.
    const response = await this.call(
      `/projects/${projectId(repo.fullName)}/repository/files/${encodeURIComponent(path.replace(/^\/+/, ''))}/raw?ref=${encodeURIComponent(sha)}`,
      { headers: { accept: '*/*' } },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new SourceProviderError(await errorMessage(response), response.status, 'gitlab');
    }
    return response.text();
  }

  async findFiles(repo: RepositoryRef, sha: string, name: string): Promise<string[]> {
    // L'arbre récursif, cent entrées par page. Au-delà de `MAX_PAGES`, on rend
    // ce qu'on a : un dépôt de cette taille garde son pupitre.json près de la racine.
    const found: string[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await this.call(
        `/projects/${projectId(repo.fullName)}/repository/tree?ref=${encodeURIComponent(sha)}&recursive=true&per_page=${PAGE_SIZE}&page=${page}`,
      );
      const entries = await this.json<Array<{ path: string; type: string }>>(response);
      for (const entry of entries) {
        if (entry.type === 'blob' && (entry.path === name || entry.path.endsWith(`/${name}`))) {
          found.push(entry.path);
        }
      }
      if (entries.length < PAGE_SIZE || !response.headers.get('x-next-page')) break;
    }
    return found.sort();
  }

  async commit(repo: RepositoryRef, sha: string): Promise<SourceCommit> {
    const body = await this.json<{
      id: string;
      message: string;
      author_name?: string | null;
      web_url?: string;
    }>(
      await this.call(
        `/projects/${projectId(repo.fullName)}/repository/commits/${encodeURIComponent(sha)}`,
      ),
    );
    return {
      sha: body.id,
      message: body.message,
      author: body.author_name || null,
      url: body.web_url ?? null,
    };
  }

  async downloadArchive(
    repo: RepositoryRef,
    sha: string,
    destination: string,
    maxBytes: number,
  ): Promise<{ bytes: number }> {
    // Un dossier de tête, `projet-<sha>-<sha>` : le driver le retire à l'extraction.
    const response = await this.call(
      `/projects/${projectId(repo.fullName)}/repository/archive.tar.gz?sha=${encodeURIComponent(sha)}`,
      { headers: { accept: '*/*' }, plain: true },
    );
    if (!response.ok || !response.body) {
      throw new SourceProviderError(await errorMessage(response), response.status, 'gitlab');
    }

    const tooLarge = sourceSay(this.credentials.language ?? 'fr')('archive.tooLarge', {
      mib: Math.round(maxBytes / 1024 / 1024),
    });
    let bytes = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          done(new SourceProviderError(tooLarge, null, 'gitlab'));
          return;
        }
        done(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
        cap,
        createWriteStream(destination),
      );
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      throw error;
    }
    return { bytes };
  }

  async reportStatus(repo: RepositoryRef, sha: string, status: CommitStatus): Promise<void> {
    const response = await this.call(
      `/projects/${projectId(repo.fullName)}/statuses/${encodeURIComponent(sha)}`,
      {
        method: 'POST',
        body: {
          state: GITLAB_STATE[status.state],
          name: status.context,
          description: status.description.slice(0, 255),
          ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
        },
      },
    );
    // GitLab tient un automate par statut : redire « pending » à un statut
    // déjà en attente est refusé. L'état est celui qu'on voulait, rien à faire.
    if (response.status === 400) {
      const message = await errorMessage(response);
      if (message.includes('Cannot transition status')) return;
      throw new SourceProviderError(message, 400, 'gitlab');
    }
    // Le refus le plus courant, et le moins lisible : une branche protégée.
    if (response.status === 403) {
      throw new SourceProviderError(
        sourceSay(this.credentials.language ?? 'fr')('gitlab.protectedBranch', {
          error: await errorMessage(response),
        }),
        403,
        'gitlab',
      );
    }
    await this.json<unknown>(response);
  }

  /**
   * Les projets dont le compte du jeton est membre — ceux d'un jeton de projet
   * ou de groupe, ou d'un compte. Jamais la liste publique de l'instance, qui
   * sur gitlab.com en rendrait des millions. Les projets archivés et les
   * dépôts vides (sans branche) n'ont rien à déployer.
   */
  async listRepositories(): Promise<SourceRepository[]> {
    const repositories = new Map<string, SourceRepository>();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await this.json<GitLabProject[]>(
        await this.call(
          `/projects?membership=true&archived=false&simple=true&order_by=id&sort=asc&per_page=${PAGE_SIZE}&page=${page}`,
        ),
      );
      for (const project of body) {
        if (!project.default_branch) continue;
        repositories.set(project.path_with_namespace, {
          provider: 'gitlab',
          fullName: project.path_with_namespace,
          installationId: null,
          defaultBranch: project.default_branch,
          private: project.visibility !== 'public',
          htmlUrl: project.web_url,
        });
      }
      if (body.length < PAGE_SIZE) break;
    }
    return [...repositories.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  }
}

export type GitLabAccount = {
  /** Le compte du jeton : un utilisateur, ou le robot d'un jeton de projet ou de groupe. */
  login: string;
  /** La version de l'instance. */
  version: string;
  /** L'adresse de l'instance, nettoyée. */
  baseUrl: string;
  /** Les portées du jeton, quand l'instance sait les dire. */
  scopes: string[] | null;
  /** Son échéance (`AAAA-MM-JJ`), `null` s'il n'en a pas ou si l'instance ne la dit pas. */
  expiresAt: string | null;
};

/**
 * Vérifie une adresse et un jeton saisis à la main : l'instance répond-elle,
 * à quel compte le jeton ouvre-t-il, et porte-t-il `api` ? C'est « Tester »
 * sur l'écran des intégrations, avant d'enregistrer quoi que ce soit.
 */
export async function fetchGitLabAccount(
  credentials: GitLabCredentials,
  fetchImpl: FetchLike = fetch,
  guard: (url: string) => Promise<void> = assertEgressAllowed,
): Promise<GitLabAccount> {
  const baseUrl = gitlabBaseUrl(credentials.baseUrl);
  const say = sourceSay(credentials.language ?? 'fr');
  const call = async (path: string, optional = false) => {
    const url = `${baseUrl}/api/v4${path}`;
    try {
      await guard(url);
    } catch (error) {
      if (error instanceof EgressRefusedError) {
        throw new SourceProviderError(error.describe(credentials.language ?? 'fr'), null, 'gitlab');
      }
      throw error;
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { ...BASE_HEADERS, 'private-token': credentials.token },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceProviderError(`GitLab injoignable : ${message}`, null, 'gitlab');
    }
    if (!response.ok) {
      if (optional) return null;
      throw new SourceProviderError(await errorMessage(response), response.status, 'gitlab');
    }
    return (await response.json()) as Record<string, unknown>;
  };
  const user = await call('/user');
  const version = await call('/version');
  // Une instance ancienne ne sait pas décrire le jeton : on s'en passe.
  const token = await call('/personal_access_tokens/self', true);
  const scopes =
    token && Array.isArray(token.scopes)
      ? token.scopes.filter((scope): scope is string => typeof scope === 'string')
      : null;
  if (scopes && !scopes.includes('api')) {
    throw new SourceProviderError(
      say('gitlab.noApiScope', { scopes: scopes.join(', ') || say('gitlab.noScope') }),
      403,
      'gitlab',
    );
  }
  return {
    login: typeof user?.username === 'string' ? user.username : '?',
    version: typeof version?.version === 'string' ? version.version : '?',
    baseUrl,
    scopes,
    expiresAt: typeof token?.expires_at === 'string' ? token.expires_at : null,
  };
}
