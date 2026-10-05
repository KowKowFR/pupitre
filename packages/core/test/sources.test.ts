import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseAppSpec, type AppSpec } from '../src/spec/index.js';
import {
  GitHubSourceProvider,
  GitLabSourceProvider,
  GiteaSourceProvider,
  SourceProviderError,
  branchWebUrl,
  commitWebUrl,
  createSourceProvider,
  fetchGitLabAccount,
  fetchGiteaAccount,
  giteaBaseUrl,
  gitlabBaseUrl,
  githubWebUrl,
  classifySpecChange,
  defaultWatchPaths,
  githubAppJwt,
  githubAppManifest,
  matchesWatchPath,
  parseSourceSpec,
  sourceRepositorySchema,
  touchesWatchPaths,
} from '../src/sources/index.js';

/**
 * Linked repositories: what decides that a commit goes out on its own or waits
 * for a human, that it concerns an application of a monorepo, that its spec is
 * valid — and the GitHub client, against a fake `fetch`.
 */

const BASE: AppSpec = parseAppSpec({
  name: 'demo-api',
  version: '1.0.0',
  services: [
    {
      name: 'api',
      source: { type: 'image', ref: 'ghcr.io/acme/api:1.0.0' },
      port: 80,
      exposed: true,
      env: { NODE_ENV: 'production' },
    },
  ],
});

function withChanges(change: (spec: AppSpec) => void): AppSpec {
  const next = structuredClone(BASE);
  change(next);
  return parseAppSpec(next);
}

describe('code or infrastructure change', () => {
  it('a new version and a new image tag: code, which goes out on its own', () => {
    const report = classifySpecChange(
      BASE,
      withChanges((spec) => {
        spec.version = '1.1.0';
        spec.services[0]!.source = { type: 'image', ref: 'ghcr.io/acme/api:1.1.0' };
      }),
    );
    assert.equal(report.infra, false);
    assert.deepEqual(
      report.changes.map((change) => change.path),
      ['version', 'services.api.source'],
    );
  });

  it('a port, a volume, a secret or a variable: infra, which waits for a human', () => {
    for (const change of [
      (spec: AppSpec) => void (spec.services[0]!.port = 8080),
      (spec: AppSpec) => void (spec.services[0]!.env = { NODE_ENV: 'staging' }),
      (spec: AppSpec) => void (spec.services[0]!.replicas = 3),
      (spec: AppSpec) =>
        void (spec.services[0]!.volumes = [{ name: 'data', mountPath: '/data', size: '1Gi' }]),
    ]) {
      assert.equal(classifySpecChange(BASE, withChanges(change)).infra, true);
    }
  });

  it('a service added, a domain set: infra', () => {
    const report = classifySpecChange(
      BASE,
      withChanges((spec) => {
        spec.ingress = { host: 'api.acme.fr', tls: true, targetService: 'api' };
      }),
    );
    assert.equal(report.infra, true);
    assert.deepEqual(report.changes, [{ path: 'ingress', kind: 'infra', change: 'added' }]);
  });

  it('going from an image to a build changes how it is made: infra', () => {
    const report = classifySpecChange(
      BASE,
      withChanges((spec) => {
        spec.services[0]!.source = { type: 'dockerfile', context: '.', dockerfile: 'Dockerfile' };
      }),
    );
    assert.equal(report.infra, true);
  });

  it('nothing changed: no change, and the order of keys does not count', () => {
    const reordered = parseAppSpec(JSON.parse(JSON.stringify(BASE)));
    assert.deepEqual(classifySpecChange(BASE, reordered), { infra: false, changes: [] });
  });

  it('without a previous spec, everything is new', () => {
    assert.equal(classifySpecChange(null, BASE).infra, true);
  });
});

describe('watched paths of a monorepo', () => {
  it('a folder covers everything it contains, and only that', () => {
    assert.ok(matchesWatchPath('apps/api/src/index.ts', 'apps/api/**'));
    assert.ok(matchesWatchPath('apps/api/src/index.ts', 'apps/api'));
    assert.ok(!matchesWatchPath('apps/api-v2/index.ts', 'apps/api'));
    assert.ok(!matchesWatchPath('apps/web/index.ts', 'apps/api/**'));
  });

  it('`*` stops at one segment, `**` crosses them', () => {
    assert.ok(matchesWatchPath('apps/api/Dockerfile', 'apps/*/Dockerfile'));
    assert.ok(!matchesWatchPath('apps/api/deep/Dockerfile', 'apps/*/Dockerfile'));
    assert.ok(matchesWatchPath('packages/shared/a/b.ts', 'packages/**/b.ts'));
    assert.ok(matchesWatchPath('README.md', '**'));
  });

  it('a commit on the docs does not redeploy the API; a commit on its spec does', () => {
    const watch = ['apps/api/**', 'packages/shared/**'];
    assert.equal(touchesWatchPaths(['docs/guide.md'], watch, 'apps/api/pupitre.json'), false);
    assert.equal(touchesWatchPaths(['packages/shared/x.ts'], watch, 'apps/api/pupitre.json'), true);
    assert.equal(touchesWatchPaths(['apps/api/pupitre.json'], [], 'apps/api/pupitre.json'), true);
  });

  it('by default: the spec’s folder, or the whole repository if it is at the root', () => {
    assert.deepEqual(defaultWatchPaths('pupitre.json'), ['**']);
    assert.deepEqual(defaultWatchPaths('apps/api/pupitre.json'), ['apps/api/**']);
  });
});

describe('pupitre.json', () => {
  it('accepts a valid AppSpec under the application’s name', () => {
    const result = parseSourceSpec(JSON.stringify(BASE), 'demo-api');
    assert.equal(result.ok, true);
  });

  it('refuses unreadable JSON, an invalid spec, another name — and says why', () => {
    const broken = parseSourceSpec('{ "name": ', 'demo-api');
    assert.equal(broken.ok, false);
    assert.match(broken.ok ? '' : broken.issues[0]!, /JSON illisible/);

    const invalid = parseSourceSpec(JSON.stringify({ name: 'demo-api', version: 'x' }), 'demo-api');
    assert.equal(invalid.ok, false);

    const other = parseSourceSpec(JSON.stringify({ ...BASE, name: 'autre-app' }), 'demo-api');
    assert.equal(other.ok, false);
    assert.match(other.ok ? '' : other.issues[0]!, /autre-app/);
  });
});

// ─── GitHub client ─────────────────────────────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A fake GitHub: one response per URL pattern, and the trace of the calls. */
function fakeGitHub(routes: Array<[RegExp, (call: Call) => Response]>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = routes.find(([pattern]) => pattern.test(call.url));
    if (!route) return new Response('{"message":"Not Found"}', { status: 404 });
    return route[1](call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const TOKEN_ROUTE: [RegExp, (call: Call) => Response] = [
  /\/app\/installations\/42\/access_tokens$/,
  () =>
    Response.json({ token: 'ghs_installation', expires_at: '2099-01-01T00:00:00Z' }, { status: 201 }),
];

const REPO = { fullName: 'acme/api', installationId: 42 };
const SHA = 'a'.repeat(40);

describe('GitHub client', () => {
  it('signs a verifiable App JWT, valid for less than ten minutes', () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    const jwt = githubAppJwt(123, privateKey, now);
    const [header, payload, signature] = jwt.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    assert.ok(verifier.verify(publicKey, signature!, 'base64url'));
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    assert.equal(claims.iss, 123);
    assert.ok(claims.exp - claims.iat <= 600);
  });

  it('“nothing new” answers 304: we say so without reading a body, and the ETag goes out', async () => {
    const { fetchImpl, calls } = fakeGitHub([
      TOKEN_ROUTE,
      [/\/commits\/main$/, () => new Response(null, { status: 304 })],
    ]);
    const github = new GitHubSourceProvider({ appId: 1, privateKey }, fetchImpl);
    assert.deepEqual(await github.resolveHead(REPO, 'main', '"etag-1"'), { changed: false });
    const head = calls.find((call) => call.url.endsWith('/commits/main'))!;
    assert.equal(head.headers['if-none-match'], '"etag-1"');
    assert.equal(head.headers.authorization, 'token ghs_installation');
  });

  it('a new commit: its hash and the new ETag', async () => {
    const { fetchImpl } = fakeGitHub([
      TOKEN_ROUTE,
      [/\/commits\/main$/, () => new Response(`${SHA}\n`, { headers: { etag: '"etag-2"' } })],
    ]);
    const github = new GitHubSourceProvider({ appId: 1, privateKey }, fetchImpl);
    assert.deepEqual(await github.resolveHead(REPO, 'main', null), {
      changed: true,
      sha: SHA,
      etag: '"etag-2"',
    });
  });

  it('keeps the installation token while it lives: a single exchange for two calls', async () => {
    const { fetchImpl, calls } = fakeGitHub([
      TOKEN_ROUTE,
      [/\/commits\/main$/, () => new Response(SHA)],
    ]);
    const github = new GitHubSourceProvider({ appId: 1, privateKey }, fetchImpl);
    await github.resolveHead(REPO, 'main', null);
    await github.resolveHead(REPO, 'main', null);
    assert.equal(calls.filter((call) => call.url.includes('access_tokens')).length, 1);
  });

  it('a rewritten (force-push) or too long comparison is not trusted', async () => {
    const { fetchImpl } = fakeGitHub([
      TOKEN_ROUTE,
      [/\/compare\/b{40}\.\.\.a{40}$/, () => Response.json({ status: 'diverged', files: [] })],
      [
        /\/compare\/c{40}\.\.\.a{40}$/,
        () =>
          Response.json({
            status: 'ahead',
            files: [{ filename: 'apps/api/new.ts', previous_filename: 'apps/api/old.ts' }],
          }),
      ],
    ]);
    const github = new GitHubSourceProvider({ appId: 1, privateKey }, fetchImpl);
    assert.equal((await github.compare(REPO, 'b'.repeat(40), SHA)).kind, 'unknown');
    assert.deepEqual(await github.compare(REPO, 'c'.repeat(40), SHA), {
      kind: 'files',
      files: ['apps/api/new.ts', 'apps/api/old.ts'],
    });
    // Base commit not found: we do not know, so everything changed.
    assert.equal((await github.compare(REPO, 'd'.repeat(40), SHA)).kind, 'unknown');
  });

  it('finds the pupitre.json files of the commit’s tree, and only them', async () => {
    const { fetchImpl, calls } = fakeGitHub([
      TOKEN_ROUTE,
      [
        /\/git\/trees\/a{40}\?recursive=1$/,
        () =>
          Response.json({
            tree: [
              { path: 'pupitre.json', type: 'blob' },
              { path: 'examples/bonjour/pupitre.json', type: 'blob' },
              { path: 'examples/bonjour', type: 'tree' },
              { path: 'docs/pupitre.json.md', type: 'blob' },
              { path: 'apps/api/not-pupitre.json', type: 'blob' },
            ],
          }),
      ],
    ]);
    const github = new GitHubSourceProvider({ appId: 1, privateKey }, fetchImpl);
    assert.deepEqual(await github.findFiles(REPO, SHA, 'pupitre.json'), [
      'examples/bonjour/pupitre.json',
      'pupitre.json',
    ]);
    assert.ok(calls.some((call) => call.url.includes('/repos/acme/api/git/trees/')));
  });

  it('a file absent at the commit is `null`, not an error', async () => {
    const { fetchImpl } = fakeGitHub([TOKEN_ROUTE]);
    const github = new GitHubSourceProvider({ appId: 1, privateKey }, fetchImpl);
    assert.equal(await github.readFile(REPO, SHA, 'pupitre.json'), null);
  });

  it('the commit status: description cut at 140 characters, link to the run', async () => {
    const { fetchImpl, calls } = fakeGitHub([
      TOKEN_ROUTE,
      [/\/statuses\/a{40}$/, () => Response.json({}, { status: 201 })],
    ]);
    const github = new GitHubSourceProvider({ appId: 1, privateKey }, fetchImpl);
    await github.reportStatus(REPO, SHA, {
      state: 'success',
      description: 'x'.repeat(300),
      context: 'pupitre/prod-1',
      targetUrl: 'http://pupitre.lan/deployments/1',
    });
    const status = calls.find((call) => call.url.includes('/statuses/'))!;
    assert.equal(status.method, 'POST');
    assert.equal((status.body as { description: string }).description.length, 140);
    assert.equal((status.body as { target_url: string }).target_url, 'http://pupitre.lan/deployments/1');
  });

  it('the manifest only asks to read the code and write statuses, without a webhook', () => {
    const manifest = githubAppManifest({
      name: 'Pupitre — atelier',
      panelUrl: 'http://pupitre.lan',
      redirectUrl: 'http://pupitre.lan/api/integrations/github/callback',
      setupUrl: 'http://pupitre.lan/admin/settings/integrations',
    });
    assert.deepEqual(manifest.default_permissions, {
      contents: 'read',
      metadata: 'read',
      statuses: 'write',
    });
    // A webhook block, even disabled, makes a private panel's manifest be refused:
    // GitHub wants its URL to be reachable from the Internet.
    assert.equal('hook_attributes' in manifest, false);
    assert.deepEqual(manifest.default_events, []);
    assert.equal(manifest.public, false);
  });
});

// ─── Gitea / Forgejo ──────────────────────────────────────────────────────────

const GITEA = { baseUrl: 'https://forge.exemple.fr/', token: 'jeton-gitea' };
const GITEA_REPO = { fullName: 'atelier/vitrine', installationId: null };
const BASE_SHA = 'b'.repeat(40);
/** The network egress guard, without DNS: everything passes. */
const open = async () => undefined;

describe('Gitea client', () => {
  it('the forge’s address is cleaned up, and only http(s) passes', () => {
    assert.equal(giteaBaseUrl(' https://codeberg.org/ '), 'https://codeberg.org');
    assert.equal(giteaBaseUrl('http://10.0.0.5:3000/git/'), 'http://10.0.0.5:3000/git');
    assert.throws(() => giteaBaseUrl('ftp://forge'), SourceProviderError);
  });

  it('a branch’s head: its hash, without an ETag, through the token', async () => {
    const { fetchImpl, calls } = fakeGitHub([
      [
        /\/api\/v1\/repos\/atelier\/vitrine\/branches\/main$/,
        () => Response.json({ commit: { id: SHA } }),
      ],
    ]);
    const gitea = new GiteaSourceProvider(GITEA, fetchImpl, open);
    assert.deepEqual(await gitea.resolveHead(GITEA_REPO, 'main', '"ignored"'), {
      changed: true,
      sha: SHA,
      etag: null,
    });
    assert.equal(
      calls[0]!.url,
      'https://forge.exemple.fr/api/v1/repos/atelier/vitrine/branches/main',
    );
    assert.equal(calls[0]!.headers.authorization, 'token jeton-gitea');
  });

  it('a comparison: the commits’ files, and nothing that could be believed wrongly', async () => {
    const commit = (
      sha: string,
      parent: string,
      files: Array<{ filename: string; status?: string }>,
    ) => ({
      sha,
      parents: [{ sha: parent }],
      files,
    });
    const { fetchImpl } = fakeGitHub([
      [
        /\/compare\/b{40}\.\.\.a{40}$/,
        () =>
          Response.json({
            total_commits: 2,
            commits: [
              commit('c'.repeat(40), BASE_SHA, [{ filename: 'api/main.go', status: 'modified' }]),
              commit(SHA, 'c'.repeat(40), [{ filename: 'docs/README.md', status: 'added' }]),
            ],
          }),
      ],
      [/\/compare\/d{40}\.\.\.a{40}$/, () => Response.json({ total_commits: 0, commits: [] })],
      [
        /\/compare\/e{40}\.\.\.a{40}$/,
        () => Response.json({ total_commits: 1, commits: [commit(SHA, 'f'.repeat(40), [])] }),
      ],
      [
        /\/compare\/1{40}\.\.\.a{40}$/,
        () =>
          Response.json({
            total_commits: 1,
            commits: [commit(SHA, '1'.repeat(40), [{ filename: 'neuf.txt', status: 'renamed' }])],
          }),
      ],
      [
        /\/compare\/2{40}\.\.\.a{40}$/,
        () => Response.json({ total_commits: 80, commits: [commit(SHA, '2'.repeat(40), [])] }),
      ],
    ]);
    const gitea = new GiteaSourceProvider(GITEA, fetchImpl, open);
    assert.deepEqual(await gitea.compare(GITEA_REPO, BASE_SHA, SHA), {
      kind: 'files',
      files: ['api/main.go', 'docs/README.md'],
    });
    assert.deepEqual(await gitea.compare(GITEA_REPO, SHA, SHA), { kind: 'files', files: [] });
    for (const base of ['d', 'e', '1', '2', '9']) {
      const result = await gitea.compare(GITEA_REPO, base.repeat(40), SHA);
      assert.equal(result.kind, 'unknown', base);
    }
  });

  it('the tree’s pupitre.json files, page after page', async () => {
    const { fetchImpl, calls } = fakeGitHub([
      [
        /\/git\/trees\/a{40}\?recursive=true&per_page=1000&page=1$/,
        () =>
          Response.json({
            truncated: true,
            tree: [
              { path: 'pupitre.json', type: 'blob' },
              { path: 'apps', type: 'tree' },
              { path: 'apps/api/pupitre.json.bak', type: 'blob' },
            ],
          }),
      ],
      [
        /\/git\/trees\/a{40}\?recursive=true&per_page=1000&page=2$/,
        () =>
          Response.json({
            truncated: false,
            tree: [{ path: 'apps/api/pupitre.json', type: 'blob' }],
          }),
      ],
    ]);
    const gitea = new GiteaSourceProvider(GITEA, fetchImpl, open);
    assert.deepEqual(await gitea.findFiles(GITEA_REPO, SHA, 'pupitre.json'), [
      'apps/api/pupitre.json',
      'pupitre.json',
    ]);
    assert.equal(calls.length, 2);
  });

  it('an absent file is `null`; the status goes out with its context and its link', async () => {
    const { fetchImpl, calls } = fakeGitHub([
      [/\/statuses\/a{40}$/, () => Response.json({ id: 1 }, { status: 201 })],
    ]);
    const gitea = new GiteaSourceProvider(GITEA, fetchImpl, open);
    assert.equal(await gitea.readFile(GITEA_REPO, SHA, 'pupitre.json'), null);
    await gitea.reportStatus(GITEA_REPO, SHA, {
      state: 'success',
      description: 'x'.repeat(400),
      context: 'pupitre/prod-1',
      targetUrl: 'https://pupitre.exemple.fr/deployments/1',
    });
    const status = calls.find((call) => call.method === 'POST')!;
    assert.equal(status.body.context, 'pupitre/prod-1');
    assert.equal(status.body.target_url, 'https://pupitre.exemple.fr/deployments/1');
    assert.equal(status.body.description.length, 255);
  });

  it('the account’s repositories, page after page — never the instance’s public search', async () => {
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        full_name: `atelier/depot-${n}-${i}`,
        default_branch: 'main',
        private: true,
        html_url: `https://forge.exemple.fr/atelier/depot-${n}-${i}`,
      }));
    const { fetchImpl, calls } = fakeGitHub([
      [/\/user\/repos\?limit=50&page=1$/, () => Response.json(page(1, 50))],
      [/\/user\/repos\?limit=50&page=2$/, () => Response.json(page(2, 3))],
    ]);
    const gitea = new GiteaSourceProvider(GITEA, fetchImpl, open);
    const repos = await gitea.listRepositories();
    assert.equal(repos.length, 53);
    assert.deepEqual(
      { provider: repos[0]!.provider, installationId: repos[0]!.installationId },
      { provider: 'gitea', installationId: null },
    );
    assert.ok(calls.every((call) => !call.url.includes('/repos/search')));
  });

  it('the network egress guard: a forge on a link-local address is refused', async () => {
    const { fetchImpl, calls } = fakeGitHub([]);
    const gitea = new GiteaSourceProvider(
      { baseUrl: 'http://169.254.169.254', token: 't' },
      fetchImpl,
    );
    await assert.rejects(gitea.resolveHead(GITEA_REPO, 'main', null), SourceProviderError);
    assert.equal(calls.length, 0);
  });

  it('“Test” says which account the token opens, and refuses an invalid token', async () => {
    const ok = fakeGitHub([
      [/\/api\/v1\/version$/, () => Response.json({ version: '11.0.3+gitea-1.22.0' })],
      [/\/api\/v1\/user$/, () => Response.json({ login: 'pupitre-bot' })],
    ]);
    assert.deepEqual(await fetchGiteaAccount(GITEA, ok.fetchImpl, open), {
      login: 'pupitre-bot',
      version: '11.0.3+gitea-1.22.0',
      baseUrl: 'https://forge.exemple.fr',
    });
    const refused = fakeGitHub([
      [/\/api\/v1\/version$/, () => Response.json({ version: '1.24.7' })],
      [/\/api\/v1\/user$/, () => Response.json({ message: 'token is required' }, { status: 401 })],
    ]);
    await assert.rejects(fetchGiteaAccount(GITEA, refused.fetchImpl, open), (error: unknown) => {
      assert.ok(error instanceof SourceProviderError);
      assert.equal(error.status, 401);
      return true;
    });
  });
});

// ─── GitLab ───────────────────────────────────────────────────────────────────

const GITLAB = { baseUrl: 'https://gitlab.exemple.fr/', token: 'glpat-jeton' };
/** A subgroup project: its whole path is its name. */
const GITLAB_REPO = { fullName: 'atelier/web/vitrine', installationId: null };
const GITLAB_PROJECT = 'https://gitlab.exemple.fr/api/v4/projects/atelier%2Fweb%2Fvitrine';

describe('GitLab client', () => {
  it('the instance’s address is cleaned up, and only http(s) passes', () => {
    assert.equal(gitlabBaseUrl(' https://gitlab.com/ '), 'https://gitlab.com');
    assert.equal(gitlabBaseUrl('http://10.0.0.5:8929/gitlab/'), 'http://10.0.0.5:8929/gitlab');
    assert.throws(() => gitlabBaseUrl('ssh://gitlab.com'), SourceProviderError);
  });

  it('a branch’s head: the project encoded in one block, the branch too, the token in a header', async () => {
    const { fetchImpl, calls } = fakeGitHub([
      [/\/repository\/branches\/feature%2Fx$/, () => Response.json({ commit: { id: SHA } })],
    ]);
    const gitlab = new GitLabSourceProvider(GITLAB, fetchImpl, open);
    assert.deepEqual(await gitlab.resolveHead(GITLAB_REPO, 'feature/x', '"ignored"'), {
      changed: true,
      sha: SHA,
      etag: null,
    });
    assert.equal(calls[0]!.url, `${GITLAB_PROJECT}/repository/branches/feature%2Fx`);
    assert.equal(calls[0]!.headers['private-token'], 'glpat-jeton');
    assert.equal(calls[0]!.headers.authorization, undefined);
  });

  it('a comparison: the diffs’ paths, both of a rename, and nothing that could be believed wrongly', async () => {
    const { fetchImpl, calls } = fakeGitHub([
      [
        /\/compare\?from=b{40}&to=a{40}$/,
        () =>
          Response.json({
            commits: [
              { id: 'c'.repeat(40), parent_ids: [BASE_SHA] },
              { id: SHA, parent_ids: ['c'.repeat(40)] },
            ],
            diffs: [
              { old_path: 'api/main.go', new_path: 'api/main.go' },
              { old_path: 'docs/vieux.md', new_path: 'docs/neuf.md', renamed_file: true },
            ],
            compare_timeout: false,
          }),
      ],
      [/\/compare\?from=d{40}&to=a{40}$/, () => Response.json({ commits: [], diffs: [] })],
      [
        /\/compare\?from=e{40}&to=a{40}$/,
        () => Response.json({ commits: [{ id: SHA, parent_ids: ['f'.repeat(40)] }], diffs: [] }),
      ],
      [
        /\/compare\?from=1{40}&to=a{40}$/,
        () =>
          Response.json({
            commits: [{ id: SHA, parent_ids: ['1'.repeat(40)] }],
            diffs: [],
            compare_timeout: true,
          }),
      ],
      [
        /\/compare\?from=2{40}&to=a{40}$/,
        () =>
          Response.json({
            commits: [{ id: SHA, parent_ids: ['2'.repeat(40)] }],
            diffs: Array.from({ length: 300 }, (_, i) => ({
              old_path: `f${i}`,
              new_path: `f${i}`,
            })),
          }),
      ],
      [
        /\/compare\?from=9{40}&to=a{40}$/,
        () => Response.json({ message: '404 Ref Not Found' }, { status: 404 }),
      ],
    ]);
    const gitlab = new GitLabSourceProvider(GITLAB, fetchImpl, open);
    assert.deepEqual(await gitlab.compare(GITLAB_REPO, BASE_SHA, SHA), {
      kind: 'files',
      files: ['api/main.go', 'docs/neuf.md', 'docs/vieux.md'],
    });
    assert.ok(calls[0]!.url.startsWith(`${GITLAB_PROJECT}/repository/compare?`));
    assert.deepEqual(await gitlab.compare(GITLAB_REPO, SHA, SHA), { kind: 'files', files: [] });
    for (const base of ['d', 'e', '1', '2', '9']) {
      const result = await gitlab.compare(GITLAB_REPO, base.repeat(40), SHA);
      assert.equal(result.kind, 'unknown', base);
    }
  });

  it('a file is read by its path encoded in one block; absent, it is `null`', async () => {
    const { fetchImpl, calls } = fakeGitHub([
      [
        /\/repository\/files\/apps%2Fapi%2Fpupitre\.json\/raw\?ref=a{40}$/,
        () => new Response('{"name":"api"}'),
      ],
    ]);
    const gitlab = new GitLabSourceProvider(GITLAB, fetchImpl, open);
    assert.equal(
      await gitlab.readFile(GITLAB_REPO, SHA, '/apps/api/pupitre.json'),
      '{"name":"api"}',
    );
    assert.equal(await gitlab.readFile(GITLAB_REPO, SHA, 'pupitre.json'), null);
    assert.equal(calls.length, 2);
  });

  it('the tree’s pupitre.json files, page after page, as long as GitLab announces a next one', async () => {
    const tree = (count: number, extra: Array<{ path: string; type: string }>) => [
      ...extra,
      ...Array.from({ length: count - extra.length }, (_, i) => ({
        path: `src/f${i}.ts`,
        type: 'blob',
      })),
    ];
    const { fetchImpl, calls } = fakeGitHub([
      [
        /\/repository\/tree\?ref=a{40}&recursive=true&per_page=100&page=1$/,
        () =>
          Response.json(
            tree(100, [
              { path: 'pupitre.json', type: 'blob' },
              { path: 'apps', type: 'tree' },
              { path: 'apps/api/pupitre.json.bak', type: 'blob' },
            ]),
            { headers: { 'x-next-page': '2' } },
          ),
      ],
      [
        /\/repository\/tree\?ref=a{40}&recursive=true&per_page=100&page=2$/,
        () =>
          Response.json([{ path: 'apps/api/pupitre.json', type: 'blob' }], {
            headers: { 'x-next-page': '' },
          }),
      ],
    ]);
    const gitlab = new GitLabSourceProvider(GITLAB, fetchImpl, open);
    assert.deepEqual(await gitlab.findFiles(GITLAB_REPO, SHA, 'pupitre.json'), [
      'apps/api/pupitre.json',
      'pupitre.json',
    ]);
    assert.equal(calls.length, 2);
  });

  it('the status: the state in GitLab’s words, the context as name, and “already pending” is not an error', async () => {
    let refused = false;
    const { fetchImpl, calls } = fakeGitHub([
      [
        /\/statuses\/a{40}$/,
        (call) => {
          if ((call.body as { state: string }).state === 'pending' && refused) {
            return Response.json(
              { message: 'Cannot transition status via :enqueue from :pending' },
              { status: 400 },
            );
          }
          refused = true;
          return Response.json({ id: 1 }, { status: 201 });
        },
      ],
    ]);
    const gitlab = new GitLabSourceProvider(GITLAB, fetchImpl, open);
    const status = {
      state: 'failure' as const,
      description: 'x'.repeat(400),
      context: 'pupitre/prod-1',
      targetUrl: 'https://pupitre.exemple.fr/deployments/1',
    };
    await gitlab.reportStatus(GITLAB_REPO, SHA, status);
    const sent = calls[0]!.body as Record<string, string>;
    assert.equal(calls[0]!.url, `${GITLAB_PROJECT}/statuses/${SHA}`);
    assert.deepEqual(
      { state: sent.state, name: sent.name, target_url: sent.target_url },
      { state: 'failed', name: 'pupitre/prod-1', target_url: status.targetUrl },
    );
    assert.equal(sent.description!.length, 255);
    await gitlab.reportStatus(GITLAB_REPO, SHA, { ...status, state: 'pending' });
    await assert.rejects(
      new GitLabSourceProvider(
        GITLAB,
        fakeGitHub([
          [/\/statuses\//, () => Response.json({ message: 'name is too long' }, { status: 400 })],
        ]).fetchImpl,
        open,
      ).reportStatus(GITLAB_REPO, SHA, status),
      SourceProviderError,
    );
    // A Developer token on a protected branch: the refusal says why.
    await assert.rejects(
      new GitLabSourceProvider(
        GITLAB,
        fakeGitHub([
          [/\/statuses\//, () => Response.json({ message: '403 Forbidden' }, { status: 403 })],
        ]).fetchImpl,
        open,
      ).reportStatus(GITLAB_REPO, SHA, status),
      (error: unknown) => {
        assert.ok(error instanceof SourceProviderError);
        assert.equal(error.status, 403);
        assert.match(error.message, /branche protégée.*Maintainer/);
        return true;
      },
    );
  });

  it('the projects the token is a member of, page after page — neither the public list nor empty repositories', async () => {
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        path_with_namespace: `atelier/web/depot-${n}-${i}`,
        default_branch: i === 0 && n === 2 ? null : 'main',
        visibility: i % 2 ? 'public' : 'private',
        web_url: `https://gitlab.exemple.fr/atelier/web/depot-${n}-${i}`,
      }));
    const { fetchImpl, calls } = fakeGitHub([
      [/\/projects\?membership=true&.*&page=1$/, () => Response.json(page(1, 100))],
      [/\/projects\?membership=true&.*&page=2$/, () => Response.json(page(2, 3))],
    ]);
    const gitlab = new GitLabSourceProvider(GITLAB, fetchImpl, open);
    const repos = await gitlab.listRepositories();
    assert.equal(repos.length, 102, 'the empty repository is left out');
    assert.deepEqual(
      { provider: repos[0]!.provider, installationId: repos[0]!.installationId },
      { provider: 'gitlab', installationId: null },
    );
    assert.ok(repos.some((repo) => repo.private) && repos.some((repo) => !repo.private));
    assert.ok(calls.every((call) => call.url.includes('membership=true')));
  });

  it('the archive goes out without `sec-fetch-mode` — GitLab refuses it to a “cors” request — and stays capped', async () => {
    let seen: IncomingHttpHeaders = {};
    let url = '';
    const server = createServer((request, response) => {
      seen = request.headers;
      url = request.url ?? '';
      response.writeHead(200, { 'content-type': 'application/x-gzip' });
      response.end(Buffer.alloc(4096, 7));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const dir = mkdtempSync(join(tmpdir(), 'pupitre-gitlab-'));
    try {
      const { port } = server.address() as AddressInfo;
      const { fetchImpl, calls } = fakeGitHub([]);
      const gitlab = new GitLabSourceProvider(
        { baseUrl: `http://127.0.0.1:${port}`, token: 'glpat-jeton' },
        fetchImpl,
        open,
      );
      const destination = join(dir, 'code.tar.gz');
      assert.deepEqual(await gitlab.downloadArchive(GITLAB_REPO, SHA, destination, 10_000), {
        bytes: 4096,
      });
      assert.equal(readFileSync(destination).length, 4096);
      assert.equal(
        url,
        `/api/v4/projects/atelier%2Fweb%2Fvitrine/repository/archive.tar.gz?sha=${SHA}`,
      );
      assert.equal(seen['private-token'], 'glpat-jeton');
      assert.equal(seen['sec-fetch-mode'], undefined);
      assert.equal(calls.length, 0, 'not through fetch');
      await assert.rejects(
        gitlab.downloadArchive(GITLAB_REPO, SHA, join(dir, 'trop.tar.gz'), 1000),
        SourceProviderError,
      );
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the network egress guard: an instance on a link-local address is refused', async () => {
    const { fetchImpl, calls } = fakeGitHub([]);
    const gitlab = new GitLabSourceProvider(
      { baseUrl: 'http://169.254.169.254', token: 't' },
      fetchImpl,
    );
    await assert.rejects(gitlab.resolveHead(GITLAB_REPO, 'main', null), SourceProviderError);
    assert.equal(calls.length, 0);
  });

  it('“Test” names the token’s account and its expiry, and refuses a token without the api scope', async () => {
    const answer = (scopes: string[]) =>
      fakeGitHub([
        [/\/api\/v4\/user$/, () => Response.json({ username: 'project_7_bot_3f2a' })],
        [/\/api\/v4\/version$/, () => Response.json({ version: '19.4.1', revision: 'abc' })],
        [
          /\/api\/v4\/personal_access_tokens\/self$/,
          () => Response.json({ scopes, expires_at: '2027-10-03' }),
        ],
      ]);
    assert.deepEqual(await fetchGitLabAccount(GITLAB, answer(['api']).fetchImpl, open), {
      login: 'project_7_bot_3f2a',
      version: '19.4.1',
      baseUrl: 'https://gitlab.exemple.fr',
      scopes: ['api'],
      expiresAt: '2027-10-03',
    });
    await assert.rejects(
      fetchGitLabAccount(GITLAB, answer(['read_api', 'read_repository']).fetchImpl, open),
      (error: unknown) => {
        assert.ok(error instanceof SourceProviderError);
        assert.match(error.message, /portée « api »/);
        return true;
      },
    );
    const refused = fakeGitHub([
      [/\/api\/v4\/user$/, () => Response.json({ message: '401 Unauthorized' }, { status: 401 })],
    ]);
    await assert.rejects(fetchGitLabAccount(GITLAB, refused.fetchImpl, open), (error: unknown) => {
      assert.ok(error instanceof SourceProviderError);
      assert.equal(error.status, 401);
      return true;
    });
  });
});

describe('providers and links', () => {
  it('the factory returns the connection’s client', () => {
    assert.equal(createSourceProvider({ provider: 'gitea', ...GITEA }).kind, 'gitea');
    assert.equal(createSourceProvider({ provider: 'gitlab', ...GITLAB }).kind, 'gitlab');
    assert.equal(
      createSourceProvider({ provider: 'github', appId: 1, privateKey, apiUrl: null }).kind,
      'github',
    );
  });

  it('a branch does not open at the same address at GitHub, Gitea and GitLab', () => {
    assert.equal(
      branchWebUrl('github', 'https://github.com/acme/api', 'feature/x'),
      'https://github.com/acme/api/tree/feature%2Fx',
    );
    assert.equal(
      branchWebUrl('gitea', 'https://codeberg.org/acme/api', 'main'),
      'https://codeberg.org/acme/api/src/branch/main',
    );
    assert.equal(
      branchWebUrl('gitlab', 'https://gitlab.com/acme/web/api', 'feature/x'),
      'https://gitlab.com/acme/web/api/-/tree/feature%2Fx',
    );
    assert.equal(
      commitWebUrl('https://codeberg.org/acme/api', SHA),
      `https://codeberg.org/acme/api/commit/${SHA}`,
    );
    assert.equal(
      commitWebUrl('https://gitlab.com/acme/web/api', SHA, 'gitlab'),
      `https://gitlab.com/acme/web/api/-/commit/${SHA}`,
    );
    assert.equal(githubWebUrl(null), 'https://github.com');
    assert.equal(githubWebUrl('https://api.github.com'), 'https://github.com');
    assert.equal(githubWebUrl('https://ghe.exemple.fr/api/v3'), 'https://ghe.exemple.fr');
  });
});

describe('repository name', () => {
  it('owner/name everywhere, and the subgroups’ path at GitLab', () => {
    for (const name of ['acme/api', 'atelier/web/vitrine', ' a.b/c-d_e ', 'a/b/c/d/e']) {
      assert.ok(sourceRepositorySchema.safeParse(name).success, name);
    }
  });

  it('no bare name, no empty segment, no `.` or `..` that would climb up in the API', () => {
    for (const name of [
      'api',
      '/acme/api',
      'acme//api',
      'acme/api/',
      '../api',
      'acme/..',
      'acme/.',
      'a/b c',
    ]) {
      assert.ok(!sourceRepositorySchema.safeParse(name).success, name);
    }
  });
});
