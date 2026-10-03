import { createSign } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
 * GitHub, par une **GitHub App** — jamais par un jeton personnel.
 *
 * Une App a trois avantages qui comptent ici : ses droits se limitent aux
 * dépôts qu'on lui a confiés (lecture du code, écriture des statuts de
 * commit) ; ses jetons d'installation expirent au bout d'une heure ; et elle
 * n'appartient à personne — un départ ne coupe pas les déploiements.
 *
 * Le webhook de l'App est **désactivé** : le panel est privé, GitHub ne
 * pourrait pas l'atteindre. Tout passe par des appels sortants — c'est Pupitre
 * qui demande, voir `types.ts`.
 *
 * Aucune dépendance : l'API REST suffit, et le jeton de l'App (un JWT signé
 * RS256) se fabrique avec `node:crypto`.
 */

export type FetchLike = typeof fetch;

export type GitHubAppCredentials = {
  appId: number;
  /** La clé privée PEM de l'App. Déchiffrée juste avant l'appel, jamais journalisée. */
  privateKey: string;
  /** `https://api.github.com`, ou l'API d'un GitHub Enterprise. */
  apiUrl?: string;
};

export const GITHUB_API_URL = 'https://api.github.com';

const BASE_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'pupitre',
};

/** GitHub plafonne une comparaison à 300 fichiers : au-delà, la liste ment. */
const COMPARE_FILE_LIMIT = 300;

/** Un jeton d'installation vit une heure ; on le renouvelle cinq minutes avant. */
const TOKEN_MARGIN_MS = 5 * 60_000;

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Le jeton de l'App : un JWT RS256 valable neuf minutes (GitHub en accepte
 * dix au plus). `iat` recule d'une minute pour absorber un écart d'horloge.
 */
export function githubAppJwt(appId: number, privateKey: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey, 'base64url')}`;
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

  // ─── authentification ───────────────────────────────────────────────────────

  private appJwt(): string {
    return githubAppJwt(this.credentials.appId, this.credentials.privateKey, this.now());
  }

  /** Jeton d'installation, gardé en mémoire tant qu'il vit. Jamais persisté. */
  private async installationToken(installationId: number | null): Promise<string> {
    if (installationId === null) {
      throw new SourceProviderError(
        'dépôt sans installation de la GitHub App : reliez-le de nouveau depuis le panel',
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

  /** `'app'` : le jeton de l'App elle-même ; sinon celui d'une installation. */
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
    // `application/vnd.github.sha` : GitHub ne rend que l'empreinte, en texte.
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
      throw new SourceProviderError(`empreinte de commit illisible : « ${sha.slice(0, 60)} »`, null, 'github');
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
    // `behind` ou `diverged` : l'historique a été réécrit, la liste ne dit pas
    // tout ce qui a changé par rapport à ce qui tourne.
    if (body.status !== 'ahead' && body.status !== 'identical') {
      return { kind: 'unknown', reason: `historique ${body.status}` };
    }
    const files = body.files ?? [];
    if (files.length >= COMPARE_FILE_LIMIT) {
      return { kind: 'unknown', reason: `plus de ${COMPARE_FILE_LIMIT} fichiers modifiés` };
    }
    // Un renommage touche l'ancien chemin comme le nouveau.
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
    // L'arbre récursif d'un commit, en un appel. GitHub le tronque au-delà de
    // ~100 000 entrées : on rend alors ce qu'il a donné — un dépôt de cette
    // taille garde son pupitre.json près de la racine.
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
    // GitHub répond par une redirection vers codeload, signée : `fetch` la suit.
    const response = await this.call(
      repo.installationId,
      `/repos/${repoPath(repo.fullName)}/tarball/${sha}`,
    );
    if (!response.ok || !response.body) {
      throw new SourceProviderError(await errorMessage(response), response.status, 'github');
    }

    let bytes = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          done(
            new SourceProviderError(
              `archive du dépôt au-delà de ${Math.round(maxBytes / 1024 / 1024)} Mio`,
              null,
              'github',
            ),
          );
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
          // GitHub refuse au-delà de 140 caractères.
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

// ─── l'App elle-même ──────────────────────────────────────────────────────────

export type GitHubInstallation = {
  id: number;
  account: string;
  accountType: 'User' | 'Organization' | string;
  repositorySelection: 'all' | 'selected' | string;
  htmlUrl: string | null;
};

/** Les comptes (personnes ou organisations) où l'App est installée. */
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

/** Vérifie des identifiants d'App saisis à la main, et dit à quelle App ils ouvrent. */
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
 * Le manifeste de création de l'App.
 *
 * C'est ce qui rend l'installation possible depuis un panel **privé** : le
 * navigateur de l'opérateur porte le manifeste jusqu'à GitHub, puis GitHub le
 * renvoie sur `redirectUrl` avec un code — à aucun moment GitHub n'appelle le
 * panel. Les droits sont les plus petits qui suffisent : lire le code, écrire
 * l'état des déploiements sur les commits.
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
    // Pas de `hook_attributes` : le panel est privé et n'attend aucun webhook.
    // Le bloc est facultatif, et s'il est là, GitHub exige que son URL soit
    // joignable depuis Internet — même avec `active: false` — et refuse le
    // manifeste d'un panel en `localhost` ou sur un réseau privé.
    public: false,
    default_permissions: { contents: 'read', metadata: 'read', statuses: 'write' },
    default_events: [],
  };
}

/** L'adresse où poster le manifeste : compte personnel, ou organisation. */
export function githubManifestUrl(organization: string | null, state: string): string {
  const base = organization
    ? `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
  return `${base}?state=${encodeURIComponent(state)}`;
}

export type GitHubManifestConversion = GitHubAppInfo & { privateKey: string };

/**
 * Le code rendu par GitHub après création, échangé contre les identifiants de
 * l'App — dont la clé privée, montrée **une seule fois** : l'appelant doit la
 * chiffrer et la ranger aussitôt.
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

/** Où installer l'App (et choisir ses dépôts) : l'écran de GitHub. */
export function githubInstallUrl(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}
