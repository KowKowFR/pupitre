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
 * Gitea, Forgejo and Codeberg — a single API (`/api/v1`), through an **access
 * token** of an account on the forge.
 *
 * No equivalent of GitHub Apps here: the token belongs to an account,
 * preferably a service account. It only needs two scopes — `write:repository`
 * (read the code, write a deployment's state on a commit; Gitea has no narrower
 * scope for statuses) and `read:user` (know which account it opens). It is
 * encrypted in the database and only lives in clear in memory, in this client.
 *
 * As for GitHub, everything starts from Pupitre: no webhook, the forge never
 * calls the panel. Gitea sets no ETag on a branch; polling therefore compares
 * the returned hash with the last commit seen.
 *
 * The forge's address is entered in the panel: each call goes through the
 * network egress guard (`assertEgressAllowed`) — a private network is allowed, a
 * cloud's metadata address is not.
 */

type FetchLike = typeof fetch;

export type GiteaCredentials = {
  /** The forge's address, as a browser opens it: `https://codeberg.org`. */
  baseUrl: string;
  /** The access token. Decrypted just before the call, never logged. */
  token: string;
  /** The language of what the client says — the instance's. French by default. */
  language?: UiLanguage;
};

/** Beyond this, a comparison is no longer trusted: everything is treated as changed. */
const COMPARE_FILE_LIMIT = 300;
const PAGE_SIZE = 50;
const MAX_PAGES = 40;

const BASE_HEADERS = { accept: 'application/json', 'user-agent': 'pupitre' };

/** `https://forge.example.com/` → `https://forge.example.com`; refuses what is not http(s). */
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

/** `owner/name` → encoded segments, for a safe API path. */
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
    // No ETag: it is the comparison with the last commit seen that says "nothing new".
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
    // Nothing in between, or a base that is not an ancestor of the head: the
    // history was rewritten (force-push), the list does not tell everything.
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
        // Gitea does not give a rename's old path: we do not know everything that
        // moved, so everything counts.
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
    // The recursive tree, by pages. Beyond `MAX_PAGES`, we return what we have: a
    // repository of that size keeps its pupitre.json near the root.
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
    // A leading folder, named after the repository: the driver strips it on
    // extraction.
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
   * The repositories the token's account owns, shares or sees through its
   * organizations — never the instance's public search, which on a forge like
   * Codeberg would return hundreds of thousands of repositories.
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
  /** The token's account. */
  login: string;
  /** The forge's version: Gitea and Forgejo both announce it. */
  version: string;
  /** The forge's address, cleaned up. */
  baseUrl: string;
};

/**
 * Checks an address and a token entered by hand: does the forge answer, and
 * which account does the token open? It is "Test" on the integrations screen,
 * before saving anything.
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
