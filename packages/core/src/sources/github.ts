import { createSign } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UiLanguage } from '../i18n.js';
import { sourceSay } from './messages.js';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
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
 * GitHub, through a **GitHub App** — never through a personal token.
 *
 * An App has three advantages that matter here: its rights are limited to the
 * repositories entrusted to it (reading code, writing commit statuses); its
 * installation tokens expire after an hour; and it belongs to nobody — someone
 * leaving does not cut deployments.
 *
 * The App's webhook is **disabled**: the panel is private, GitHub could not
 * reach it. Everything goes through outgoing calls — it is Pupitre that asks,
 * see `types.ts`.
 *
 * No dependency: the REST API is enough, and the App's token (an RS256-signed
 * JWT) is made with `node:crypto`.
 */

export type FetchLike = typeof fetch;

export type GitHubAppCredentials = {
  appId: number;
  /** The App's PEM private key. Decrypted just before the call, never logged. */
  privateKey: string;
  /** `https://api.github.com`, or a GitHub Enterprise's API. */
  apiUrl?: string;
  /** The language of what the client says — the instance's. French by default. */
  language?: UiLanguage;
};

export const GITHUB_API_URL = 'https://api.github.com';

const BASE_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'pupitre',
};

/** GitHub caps a comparison at 300 files: beyond that, the list lies. */
const COMPARE_FILE_LIMIT = 300;

/** An installation token lives one hour; we renew it five minutes before. */
const TOKEN_MARGIN_MS = 5 * 60_000;

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * The App's token: an RS256 JWT valid for nine minutes (GitHub accepts ten at
 * most). `iat` goes back one minute to absorb clock skew.
 */
export function githubAppJwt(appId: number, privateKey: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey, 'base64url')}`;
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
  return `GitHub ${response.status} : ${message}`;
}

export class GitHubSourceProvider implements SourceProvider {
  readonly kind = 'github' as const;
  private readonly apiUrl: string;
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(
    private readonly credentials: GitHubAppCredentials,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.apiUrl = (credentials.apiUrl ?? GITHUB_API_URL).replace(/\/+$/, '');
  }

  // ─── authentication ─────────────────────────────────────────────────────────

  private appJwt(): string {
    return githubAppJwt(this.credentials.appId, this.credentials.privateKey, this.now());
  }

  /** Installation token, kept in memory while it lives. Never persisted. */
  private async installationToken(installationId: number | null): Promise<string> {
    if (installationId === null) {
      throw new SourceProviderError(
        sourceSay(this.credentials.language ?? 'fr')('github.noInstallation'),
        null,
        'github',
      );
    }
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > this.now()) return cached.token;

    const response = await this.fetchImpl(
      `${this.apiUrl}/app/installations/${installationId}/access_tokens`,
      { method: 'POST', headers: { ...BASE_HEADERS, authorization: `Bearer ${this.appJwt()}` } },
    );
    if (!response.ok) {
      throw new SourceProviderError(await errorMessage(response), response.status, 'github');
    }
    const body = (await response.json()) as { token: string; expires_at: string };
    this.tokens.set(installationId, {
      token: body.token,
      expiresAt: Date.parse(body.expires_at),
    });
    return body.token;
  }

  /** `'app'`: the token of the App itself; otherwise that of an installation. */
  private async call(
    installationId: number | null | 'app',
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<Response> {
    const authorization =
      installationId === 'app'
        ? `Bearer ${this.appJwt()}`
        : `token ${await this.installationToken(installationId)}`;
    return this.fetchImpl(`${this.apiUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...BASE_HEADERS,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
        authorization,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  private async json<T>(response: Response): Promise<T> {
    if (!response.ok) {
      throw new SourceProviderError(await errorMessage(response), response.status, 'github');
    }
    return (await response.json()) as T;
  }

  // ─── SourceProvider ─────────────────────────────────────────────────────────

  async resolveHead(repo: RepositoryRef, branch: string, etag: string | null): Promise<HeadResult> {
    // `application/vnd.github.sha`: GitHub only returns the hash, as text.
    const response = await this.call(
      repo.installationId,
      `/repos/${repoPath(repo.fullName)}/commits/${encodeURIComponent(branch)}`,
      {
        headers: {
          accept: 'application/vnd.github.sha',
          ...(etag ? { 'if-none-match': etag } : {}),
        },
      },
    );
    if (response.status === 304) return { changed: false };
    if (!response.ok) {
      throw new SourceProviderError(await errorMessage(response), response.status, 'github');
    }
    const sha = (await response.text()).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new SourceProviderError(
        sourceSay(this.credentials.language ?? 'fr')('commit.unreadableSha', {
          sha: sha.slice(0, 60),
        }),
        null,
        'github',
      );
    }
    return { changed: true, sha, etag: response.headers.get('etag') };
  }

  async compare(repo: RepositoryRef, base: string, head: string): Promise<CompareResult> {
    const response = await this.call(
      repo.installationId,
      `/repos/${repoPath(repo.fullName)}/compare/${base}...${head}`,
    );
    if (response.status === 404) {
      return { kind: 'unknown', reason: `commit de base ${base.slice(0, 7)} introuvable` };
    }
    const body = await this.json<{
      status: string;
      files?: Array<{ filename: string; previous_filename?: string }>;
    }>(response);
    // `behind` or `diverged`: the history was rewritten, the list does not tell
    // everything that changed compared with what runs.
    if (body.status !== 'ahead' && body.status !== 'identical') {
      return { kind: 'unknown', reason: `historique ${body.status}` };
    }
    const files = body.files ?? [];
    if (files.length >= COMPARE_FILE_LIMIT) {
      return { kind: 'unknown', reason: `more than ${COMPARE_FILE_LIMIT} files changed` };
    }
    // A rename touches the old path as well as the new one.
    return {
      kind: 'files',
      files: files.flatMap((file) =>
        file.previous_filename ? [file.filename, file.previous_filename] : [file.filename],
      ),
    };
  }

  async readFile(repo: RepositoryRef, sha: string, path: string): Promise<string | null> {
    const response = await this.call(
      repo.installationId,
      `/repos/${repoPath(repo.fullName)}/contents/${filePath(path)}?ref=${encodeURIComponent(sha)}`,
      { headers: { accept: 'application/vnd.github.raw+json' } },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new SourceProviderError(await errorMessage(response), response.status, 'github');
    }
    return response.text();
  }

  async findFiles(repo: RepositoryRef, sha: string, name: string): Promise<string[]> {
    // A commit's recursive tree, in one call. GitHub truncates it beyond ~100,000
    // entries: we then return what it gave — a repository of that size keeps its
    // pupitre.json near the root.
    const body = await this.json<{ tree: Array<{ path: string; type: string }> }>(
      await this.call(
        repo.installationId,
        `/repos/${repoPath(repo.fullName)}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
      ),
    );
    return body.tree
      .filter(
        (entry) =>
          entry.type === 'blob' && (entry.path === name || entry.path.endsWith(`/${name}`)),
      )
      .map((entry) => entry.path)
      .sort();
  }

  async commit(repo: RepositoryRef, sha: string): Promise<SourceCommit> {
    const body = await this.json<{
      sha: string;
      html_url?: string;
      author?: { login?: string } | null;
      commit: { message: string; author?: { name?: string } | null };
    }>(await this.call(repo.installationId, `/repos/${repoPath(repo.fullName)}/commits/${sha}`));
    return {
      sha: body.sha,
      message: body.commit.message,
      author: body.author?.login ?? body.commit.author?.name ?? null,
      url: body.html_url ?? null,
    };
  }

  async downloadArchive(
    repo: RepositoryRef,
    sha: string,
    destination: string,
    maxBytes: number,
  ): Promise<{ bytes: number }> {
    // GitHub answers with a signed redirect to codeload: `fetch` follows it.
    const response = await this.call(
      repo.installationId,
      `/repos/${repoPath(repo.fullName)}/tarball/${sha}`,
    );
    if (!response.ok || !response.body) {
      throw new SourceProviderError(await errorMessage(response), response.status, 'github');
    }

    const tooLarge = sourceSay(this.credentials.language ?? 'fr')('archive.tooLarge', {
      mib: Math.round(maxBytes / 1024 / 1024),
    });
    let bytes = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          done(new SourceProviderError(tooLarge, null, 'github'));
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
      repo.installationId,
      `/repos/${repoPath(repo.fullName)}/statuses/${sha}`,
      {
        method: 'POST',
        body: {
          state: status.state,
          // GitHub refuses beyond 140 characters.
          description: status.description.slice(0, 140),
          context: status.context,
          ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
        },
      },
    );
    await this.json<unknown>(response);
  }

  async listRepositories(): Promise<SourceRepository[]> {
    const installations = await listGitHubInstallations(this.credentials, this.fetchImpl, this.now);
    const repositories: SourceRepository[] = [];
    for (const installation of installations) {
      for (let page = 1; page <= 20; page += 1) {
        const body = await this.json<{
          repositories: Array<{
            full_name: string;
            default_branch: string;
            private: boolean;
            html_url: string;
          }>;
        }>(
          await this.call(installation.id, `/installation/repositories?per_page=100&page=${page}`),
        );
        for (const repo of body.repositories) {
          repositories.push({
            provider: 'github',
            fullName: repo.full_name,
            installationId: installation.id,
            defaultBranch: repo.default_branch,
            private: repo.private,
            htmlUrl: repo.html_url,
          });
        }
        if (body.repositories.length < 100) break;
      }
    }
    return repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
  }
}

// ─── the App itself ───────────────────────────────────────────────────────────

export type GitHubInstallation = {
  id: number;
  account: string;
  accountType: 'User' | 'Organization' | string;
  repositorySelection: 'all' | 'selected' | string;
  htmlUrl: string | null;
};

/** The accounts (people or organizations) where the App is installed. */
export async function listGitHubInstallations(
  credentials: GitHubAppCredentials,
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<GitHubInstallation[]> {
  const apiUrl = (credentials.apiUrl ?? GITHUB_API_URL).replace(/\/+$/, '');
  const response = await fetchImpl(`${apiUrl}/app/installations?per_page=100`, {
    headers: {
      ...BASE_HEADERS,
      authorization: `Bearer ${githubAppJwt(credentials.appId, credentials.privateKey, now())}`,
    },
  });
  if (!response.ok) {
    throw new SourceProviderError(await errorMessage(response), response.status, 'github');
  }
  const body = (await response.json()) as Array<{
    id: number;
    account: { login: string; type: string } | null;
    repository_selection: string;
    html_url?: string;
  }>;
  return body.map((installation) => ({
    id: installation.id,
    account: installation.account?.login ?? '?',
    accountType: installation.account?.type ?? 'User',
    repositorySelection: installation.repository_selection,
    htmlUrl: installation.html_url ?? null,
  }));
}

export type GitHubAppInfo = {
  appId: number;
  slug: string;
  name: string;
  htmlUrl: string;
  owner: string;
};

/** Checks App credentials entered by hand, and says which App they open. */
export async function fetchGitHubAppInfo(
  credentials: GitHubAppCredentials,
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<GitHubAppInfo> {
  const apiUrl = (credentials.apiUrl ?? GITHUB_API_URL).replace(/\/+$/, '');
  const response = await fetchImpl(`${apiUrl}/app`, {
    headers: {
      ...BASE_HEADERS,
      authorization: `Bearer ${githubAppJwt(credentials.appId, credentials.privateKey, now())}`,
    },
  });
  if (!response.ok) {
    throw new SourceProviderError(await errorMessage(response), response.status, 'github');
  }
  const body = (await response.json()) as {
    id: number;
    slug: string;
    name: string;
    html_url: string;
    owner: { login: string } | null;
  };
  return {
    appId: body.id,
    slug: body.slug,
    name: body.name,
    htmlUrl: body.html_url,
    owner: body.owner?.login ?? '?',
  };
}

/**
 * The App's creation manifest.
 *
 * It is what makes installation possible from a **private** panel: the
 * operator's browser carries the manifest to GitHub, then GitHub sends it back
 * to `redirectUrl` with a code — at no point does GitHub call the panel. The
 * rights are the smallest that suffice: read the code, write the deployments'
 * state on the commits.
 */
export function githubAppManifest(options: {
  name: string;
  panelUrl: string;
  redirectUrl: string;
  setupUrl: string;
}): Record<string, unknown> {
  return {
    name: options.name.slice(0, 34),
    url: options.panelUrl,
    redirect_url: options.redirectUrl,
    setup_url: options.setupUrl,
    // No `hook_attributes`: the panel is private and expects no webhook. The block
    // is optional, and if it is there, GitHub requires its URL to be reachable from
    // the Internet — even with `active: false` — and refuses the manifest of a
    // panel on `localhost` or on a private network.
    public: false,
    default_permissions: { contents: 'read', metadata: 'read', statuses: 'write' },
    default_events: [],
  };
}

/** The address to post the manifest to: personal account, or organization. */
export function githubManifestUrl(organization: string | null, state: string): string {
  const base = organization
    ? `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
  return `${base}?state=${encodeURIComponent(state)}`;
}

export type GitHubManifestConversion = GitHubAppInfo & { privateKey: string };

/**
 * The code returned by GitHub after creation, exchanged for the App's
 * credentials — including the private key, shown **only once**: the caller must
 * encrypt and store it right away.
 */
export async function convertGitHubManifest(
  code: string,
  fetchImpl: FetchLike = fetch,
  apiUrl = GITHUB_API_URL,
): Promise<GitHubManifestConversion> {
  const response = await fetchImpl(
    `${apiUrl.replace(/\/+$/, '')}/app-manifests/${encodeURIComponent(code)}/conversions`,
    { method: 'POST', headers: BASE_HEADERS },
  );
  if (!response.ok) {
    throw new SourceProviderError(await errorMessage(response), response.status, 'github');
  }
  const body = (await response.json()) as {
    id: number;
    slug: string;
    name: string;
    html_url: string;
    owner: { login: string } | null;
    pem: string;
  };
  return {
    appId: body.id,
    slug: body.slug,
    name: body.name,
    htmlUrl: body.html_url,
    owner: body.owner?.login ?? '?',
    privateKey: body.pem,
  };
}

/** Where to install the App (and choose its repositories): GitHub's screen. */
export function githubInstallUrl(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}
