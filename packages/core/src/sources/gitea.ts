import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
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
 * Gitea, Forgejo et Codeberg — une seule API (`/api/v1`), par un **jeton
 * d'accès** d'un compte de la forge.
 *
 * Pas d'équivalent des GitHub Apps ici : le jeton appartient à un compte, de
 * préférence un compte de service. Il ne lui faut que deux portées —
 * `write:repository` (lire le code, écrire l'état d'un déploiement sur un
 * commit ; Gitea n'a pas de portée plus étroite pour les statuts) et
 * `read:user` (savoir à quel compte il ouvre). Il est chiffré en base et ne
 * vit en clair qu'en mémoire, dans ce client.
 *
 * Comme pour GitHub, tout part de Pupitre : aucun webhook, la forge n'appelle
 * jamais le panel. Gitea ne pose pas d'ETag sur une branche ; le polling
 * compare donc l'empreinte rendue au dernier commit vu.
 *
 * L'adresse de la forge est saisie dans le panel : chaque appel passe la garde
 * des sorties réseau (`assertEgressAllowed`) — un réseau privé est permis,
 * l'adresse des métadonnées d'un cloud ne l'est pas.
 */

type FetchLike = typeof fetch;

export type GiteaCredentials = {
  /** L'adresse de la forge, telle qu'un navigateur l'ouvre : `https://codeberg.org`. */
  baseUrl: string;
  /** Le jeton d'accès. Déchiffré juste avant l'appel, jamais journalisé. */
  token: string;
  /** La langue de ce que le client dit — celle de l'instance. Français par défaut. */
  language?: UiLanguage;
};

/** Au-delà, une comparaison ne se croit plus : on traite tout comme changé. */
const COMPARE_FILE_LIMIT = 300;
const PAGE_SIZE = 50;
const MAX_PAGES = 40;

const BASE_HEADERS = { accept: 'application/json', 'user-agent': 'pupitre' };

/** `https://forge.exemple.fr/` → `https://forge.exemple.fr` ; refuse ce qui n'est pas http(s). */
export function giteaBaseUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SourceProviderError(
      `adresse de forge en ${url.protocol} : http ou https attendu`,
      null,
      'gitea',
    );
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/** `owner/name` → segments encodés, pour un chemin d'API sûr. */
function repoPath(fullName: string): string {
  return fullName
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function filePath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
  const message = typeof body?.message === 'string' ? body.message : response.statusText;
  return `Gitea ${response.status} : ${message}`;
}

type GiteaRepo = { full_name: string; default_branch: string; private: boolean; html_url: string };

export class GiteaSourceProvider implements SourceProvider {
  readonly kind = 'gitea' as const;
  private readonly apiUrl: string;

  constructor(
    private readonly credentials: GiteaCredentials,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly guard: (url: string) => Promise<void> = assertEgressAllowed,
  ) {
    this.apiUrl = `${giteaBaseUrl(credentials.baseUrl)}/api/v1`;
  }

  private async call(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<Response> {
    const url = `${this.apiUrl}${path}`;
    try {
      await this.guard(url);
    } catch (error) {
      if (error instanceof EgressRefusedError) {
        throw new SourceProviderError(
          error.describe(this.credentials.language ?? 'fr'),
          null,
          'gitea',
        );
      }
      throw error;
    }
    return this.fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: {
        ...BASE_HEADERS,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
        authorization: `token ${this.credentials.token}`,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  private async json<T>(response: Response): Promise<T> {
    if (!response.ok) {
      throw new SourceProviderError(await errorMessage(response), response.status, 'gitea');
    }
    return (await response.json()) as T;
  }

  // ─── SourceProvider ─────────────────────────────────────────────────────────

  async resolveHead(repo: RepositoryRef, branch: string): Promise<HeadResult> {
    const body = await this.json<{ commit?: { id?: string } }>(
      await this.call(`/repos/${repoPath(repo.fullName)}/branches/${encodeURIComponent(branch)}`),
    );
    const sha = body.commit?.id ?? '';
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
      throw new SourceProviderError(
        `empreinte de commit illisible : « ${sha.slice(0, 60)} »`,
        null,
        'gitea',
      );
    }
    // Pas d'ETag : c'est la comparaison au dernier commit vu qui dit « rien de neuf ».
    return { changed: true, sha, etag: null };
  }

  async compare(repo: RepositoryRef, base: string, head: string): Promise<CompareResult> {
    if (base === head) return { kind: 'files', files: [] };
    const response = await this.call(
      `/repos/${repoPath(repo.fullName)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    if (response.status === 404) {
      return { kind: 'unknown', reason: `commit de base ${base.slice(0, 7)} introuvable` };
    }
    const body = await this.json<{
      total_commits?: number;
      commits?: Array<{
        sha: string;
        parents?: Array<{ sha: string }>;
        files?: Array<{ filename: string; status?: string }>;
      }>;
    }>(response);
    const commits = body.commits ?? [];
    // Rien entre les deux, ou une base qui n'est pas un ancêtre de la tête :
    // l'historique a été réécrit (force-push), la liste ne dit pas tout.
    if (commits.length === 0) return { kind: 'unknown', reason: 'historique réécrit' };
    if (!commits.some((commit) => commit.parents?.some((parent) => parent.sha === base))) {
      return { kind: 'unknown', reason: 'historique divergent' };
    }
    if (body.total_commits !== undefined && commits.length < body.total_commits) {
      return { kind: 'unknown', reason: `${body.total_commits} commits, liste incomplète` };
    }
    const files = new Set<string>();
    for (const commit of commits) {
      for (const file of commit.files ?? []) {
        // Gitea ne donne pas l'ancien chemin d'un renommage : on ne sait pas
        // tout ce qui a bougé, donc tout compte.
        if (file.status === 'renamed')
          return { kind: 'unknown', reason: `renommage de ${file.filename}` };
        files.add(file.filename);
      }
    }
    if (files.size >= COMPARE_FILE_LIMIT) {
      return { kind: 'unknown', reason: `plus de ${COMPARE_FILE_LIMIT} fichiers modifiés` };
    }
    return { kind: 'files', files: [...files].sort() };
  }

  async readFile(repo: RepositoryRef, sha: string, path: string): Promise<string | null> {
    const response = await this.call(
      `/repos/${repoPath(repo.fullName)}/raw/${filePath(path)}?ref=${encodeURIComponent(sha)}`,
      { headers: { accept: '*/*' } },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new SourceProviderError(await errorMessage(response), response.status, 'gitea');
    }
    return response.text();
  }

  async findFiles(repo: RepositoryRef, sha: string, name: string): Promise<string[]> {
    // L'arbre récursif, par pages. Au-delà de `MAX_PAGES`, on rend ce qu'on a :
    // un dépôt de cette taille garde son pupitre.json près de la racine.
    const found: string[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await this.json<{
        tree?: Array<{ path: string; type: string }>;
        truncated?: boolean;
      }>(
        await this.call(
          `/repos/${repoPath(repo.fullName)}/git/trees/${encodeURIComponent(sha)}?recursive=true&per_page=1000&page=${page}`,
        ),
      );
      for (const entry of body.tree ?? []) {
        if (entry.type === 'blob' && (entry.path === name || entry.path.endsWith(`/${name}`))) {
          found.push(entry.path);
        }
      }
      if (!body.truncated) break;
    }
    return found.sort();
  }

  async commit(repo: RepositoryRef, sha: string): Promise<SourceCommit> {
    const body = await this.json<{
      sha: string;
      html_url?: string;
      author?: { login?: string } | null;
      commit: { message: string; author?: { name?: string } | null };
    }>(await this.call(`/repos/${repoPath(repo.fullName)}/git/commits/${encodeURIComponent(sha)}`));
    return {
      sha: body.sha,
      message: body.commit.message,
      author: body.author?.login || body.commit.author?.name || null,
      url: body.html_url ?? null,
    };
  }

  async downloadArchive(
    repo: RepositoryRef,
    sha: string,
    destination: string,
    maxBytes: number,
  ): Promise<{ bytes: number }> {
    // Un dossier de tête, au nom du dépôt : le driver le retire à l'extraction.
    const response = await this.call(
      `/repos/${repoPath(repo.fullName)}/archive/${encodeURIComponent(sha)}.tar.gz`,
      { headers: { accept: 'application/octet-stream' } },
    );
    if (!response.ok || !response.body) {
      throw new SourceProviderError(await errorMessage(response), response.status, 'gitea');
    }

    const tooLarge = sourceSay(this.credentials.language ?? 'fr')('archive.tooLarge', {
      mib: Math.round(maxBytes / 1024 / 1024),
    });
    let bytes = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          done(new SourceProviderError(tooLarge, null, 'gitea'));
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
      `/repos/${repoPath(repo.fullName)}/statuses/${encodeURIComponent(sha)}`,
      {
        method: 'POST',
        body: {
          state: status.state,
          description: status.description.slice(0, 255),
          context: status.context,
          ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
        },
      },
    );
    await this.json<unknown>(response);
  }

  /**
   * Les dépôts que le compte du jeton possède, partage ou voit par ses
   * organisations — jamais la recherche publique de l'instance, qui sur une
   * forge comme Codeberg rendrait des centaines de milliers de dépôts.
   */
  async listRepositories(): Promise<SourceRepository[]> {
    const repositories = new Map<string, SourceRepository>();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await this.json<GiteaRepo[]>(
        await this.call(`/user/repos?limit=${PAGE_SIZE}&page=${page}`),
      );
      for (const repo of body) {
        repositories.set(repo.full_name, {
          provider: 'gitea',
          fullName: repo.full_name,
          installationId: null,
          defaultBranch: repo.default_branch,
          private: repo.private,
          htmlUrl: repo.html_url,
        });
      }
      if (body.length < PAGE_SIZE) break;
    }
    return [...repositories.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  }
}

export type GiteaAccount = {
  /** Le compte du jeton. */
  login: string;
  /** La version de la forge : Gitea et Forgejo l'annoncent tous deux. */
  version: string;
  /** L'adresse de la forge, nettoyée. */
  baseUrl: string;
};

/**
 * Vérifie une adresse et un jeton saisis à la main : la forge répond-elle,
 * et à quel compte le jeton ouvre-t-il ? C'est « Tester » sur l'écran des
 * intégrations, avant d'enregistrer quoi que ce soit.
 */
export async function fetchGiteaAccount(
  credentials: GiteaCredentials,
  fetchImpl: FetchLike = fetch,
  guard: (url: string) => Promise<void> = assertEgressAllowed,
): Promise<GiteaAccount> {
  const baseUrl = giteaBaseUrl(credentials.baseUrl);
  const call = async (path: string) => {
    const url = `${baseUrl}/api/v1${path}`;
    try {
      await guard(url);
    } catch (error) {
      if (error instanceof EgressRefusedError) {
        throw new SourceProviderError(error.describe(credentials.language ?? 'fr'), null, 'gitea');
      }
      throw error;
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { ...BASE_HEADERS, authorization: `token ${credentials.token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceProviderError(`forge injoignable : ${message}`, null, 'gitea');
    }
    if (!response.ok) {
      throw new SourceProviderError(await errorMessage(response), response.status, 'gitea');
    }
    return (await response.json()) as Record<string, unknown>;
  };
  const version = await call('/version');
  const user = await call('/user');
  return {
    login: typeof user.login === 'string' ? user.login : '?',
    version: typeof version.version === 'string' ? version.version : '?',
    baseUrl,
  };
}
