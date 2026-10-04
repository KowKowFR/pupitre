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
 * GitLab — gitlab.com or a self-hosted instance, through API v4 and an **access
 * token**: preferably a project or group token, Maintainer role, `api` scope.
 *
 * `api` is wide, but GitLab has nothing narrower to write a deployment's state
 * on a commit — `read_api` reads everything, writes nothing. The role too: on a
 * protected branch, GitLab only accepts a status from whoever can push to it —
 * Maintainer by default; Developer is enough if developers can push to the
 * followed branch. A project token limits all that to a single project, a group
 * token to its projects. It is encrypted in the database and only lives in clear
 * in memory, in this client.
 *
 * A repository is named there by its full path — `group/subgroup/project` —
 * which the API takes encoded in one block as the project identifier. As for
 * GitHub and Gitea, everything starts from Pupitre: no webhook, the instance
 * never calls the panel; polling compares the branch's hash with the last
 * commit seen.
 *
 * The instance's address is entered in the panel: each call goes through the
 * network egress guard (`assertEgressAllowed`) — a private network is allowed, a
 * cloud's metadata address is not.
 */

type FetchLike = typeof fetch;
/** A GET, nothing more: enough to download an archive. */
type GetLike = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

export type GitLabCredentials = {
  /** The instance's address, as a browser opens it: `https://gitlab.com`. */
  baseUrl: string;
  /** The access token. Decrypted just before the call, never logged. */
  token: string;
  /** The language of what the client says — the instance's. French by default. */
  language?: UiLanguage;
};

/** Beyond this, a comparison is no longer trusted: everything is treated as changed. */
const COMPARE_FILE_LIMIT = 300;
/** The API v4 maximum per page. */
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

const BASE_HEADERS = { accept: 'application/json', 'user-agent': 'pupitre' };

/** `https://gitlab.example.com/` → `https://gitlab.example.com`; refuses what is not http(s). */
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
 * A GET through `node:http`, without the headers Node's `fetch` adds: it always
 * sets `sec-fetch-mode: cors`, which cannot be removed, and GitLab refuses a
 * repository's archive to a request that calls itself "cors" (406).
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

/** `group/subgroup/project` → the API's project identifier, encoded in one block. */
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

/** A commit's state, in GitLab's words. */
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
    /** The archive only: see `plainGet`. */
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
      /** Through `archiveGet` rather than `fetch`. */
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
    // No ETag: it is the comparison with the last commit seen that says "nothing new".
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
    // Nothing in between, or a base that is not an ancestor of the head: the
    // history was rewritten (force-push), the list does not tell everything.
    if (commits.length === 0) return { kind: 'unknown', reason: 'history rewritten' };
    if (!commits.some((commit) => commit.parent_ids?.includes(base))) {
      return { kind: 'unknown', reason: 'history diverged' };
    }
    // GitLab cut the comparison at its limits: the list is incomplete.
    if (body.compare_timeout) return { kind: 'unknown', reason: 'comparison truncated by GitLab' };
    const files = new Set<string>();
    for (const diff of body.diffs ?? []) {
      // A rename touches two paths: the old one and the new one.
      if (diff.renamed_file) files.add(diff.old_path);
      files.add(diff.new_path);
    }
    if (files.size >= COMPARE_FILE_LIMIT) {
      return { kind: 'unknown', reason: `more than ${COMPARE_FILE_LIMIT} files changed` };
    }
    return { kind: 'files', files: [...files].sort() };
  }

  async readFile(repo: RepositoryRef, sha: string, path: string): Promise<string | null> {
    // The file's path is also encoded in one block: `apps%2Fapi%2Fpupitre.json`.
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
    // The recursive tree, a hundred entries per page. Beyond `MAX_PAGES`, we return
    // what we have: a repository of that size keeps its pupitre.json near the root.
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
    // A leading folder, `project-<sha>-<sha>`: the driver strips it on extraction.
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
    // GitLab keeps a state machine per status: saying "pending" again to a status
    // already pending is refused. The state is the one we wanted, nothing to do.
    if (response.status === 400) {
      const message = await errorMessage(response);
      if (message.includes('Cannot transition status')) return;
      throw new SourceProviderError(message, 400, 'gitlab');
    }
    // The most common refusal, and the least readable: a protected branch.
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
   * The projects the token's account is a member of — those of a project or group
   * token, or of an account. Never the instance's public list, which on gitlab.com
   * would return millions. Archived projects and empty repositories (without a
   * branch) have nothing to deploy.
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
  /** The token's account: a user, or the bot of a project or group token. */
  login: string;
  /** The instance's version. */
  version: string;
  /** The instance's address, cleaned up. */
  baseUrl: string;
  /** The token's scopes, when the instance can tell them. */
  scopes: string[] | null;
  /** Its expiry (`YYYY-MM-DD`), `null` if it has none or the instance does not tell. */
  expiresAt: string | null;
};

/**
 * Checks an address and a token entered by hand: does the instance answer,
 * which account does the token open, and does it carry `api`? It is "Test" on
 * the integrations screen, before saving anything.
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
  // An old instance cannot describe the token: we do without.
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
