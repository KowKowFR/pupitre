import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { parseAppSpec, type AppSpec } from '../src/spec/index.js';
import {
  GitHubSourceProvider,
  classifySpecChange,
  defaultWatchPaths,
  githubAppJwt,
  githubAppManifest,
  matchesWatchPath,
  parseSourceSpec,
  touchesWatchPaths,
} from '../src/sources/index.js';

/**
 * Les dépôts liés : ce qui décide qu'un commit part tout seul ou attend un
 * humain, qu'il concerne une application d'un monorepo, que sa spec est
 * valable — et le client GitHub, contre un faux `fetch`.
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

describe('changement de code ou d’infrastructure', () => {
  it('une nouvelle version et un nouveau tag d’image : du code, qui part tout seul', () => {
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

  it('un port, un volume, un secret ou une variable : de l’infra, qui attend un humain', () => {
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

  it('un service ajouté, un domaine posé : de l’infra', () => {
    const report = classifySpecChange(
      BASE,
      withChanges((spec) => {
        spec.ingress = { host: 'api.acme.fr', tls: true, targetService: 'api' };
      }),
    );
    assert.equal(report.infra, true);
    assert.deepEqual(report.changes, [{ path: 'ingress', kind: 'infra', change: 'added' }]);
  });

  it('passer d’une image à un build change la fabrication : de l’infra', () => {
    const report = classifySpecChange(
      BASE,
      withChanges((spec) => {
        spec.services[0]!.source = { type: 'dockerfile', context: '.', dockerfile: 'Dockerfile' };
      }),
    );
    assert.equal(report.infra, true);
  });

  it('rien de changé : aucun changement, et l’ordre des clés ne compte pas', () => {
    const reordered = parseAppSpec(JSON.parse(JSON.stringify(BASE)));
    assert.deepEqual(classifySpecChange(BASE, reordered), { infra: false, changes: [] });
  });

  it('sans spec précédente, tout est nouveau', () => {
    assert.equal(classifySpecChange(null, BASE).infra, true);
  });
});

describe('chemins surveillés d’un monorepo', () => {
  it('un dossier couvre tout ce qu’il contient, et seulement lui', () => {
    assert.ok(matchesWatchPath('apps/api/src/index.ts', 'apps/api/**'));
    assert.ok(matchesWatchPath('apps/api/src/index.ts', 'apps/api'));
    assert.ok(!matchesWatchPath('apps/api-v2/index.ts', 'apps/api'));
    assert.ok(!matchesWatchPath('apps/web/index.ts', 'apps/api/**'));
  });

  it('`*` s’arrête à un segment, `**` les traverse', () => {
    assert.ok(matchesWatchPath('apps/api/Dockerfile', 'apps/*/Dockerfile'));
    assert.ok(!matchesWatchPath('apps/api/deep/Dockerfile', 'apps/*/Dockerfile'));
    assert.ok(matchesWatchPath('packages/shared/a/b.ts', 'packages/**/b.ts'));
    assert.ok(matchesWatchPath('README.md', '**'));
  });

  it('un commit sur la doc ne redéploie pas l’API ; un commit sur sa spec, si', () => {
    const watch = ['apps/api/**', 'packages/shared/**'];
    assert.equal(touchesWatchPaths(['docs/guide.md'], watch, 'apps/api/pupitre.json'), false);
    assert.equal(touchesWatchPaths(['packages/shared/x.ts'], watch, 'apps/api/pupitre.json'), true);
    assert.equal(touchesWatchPaths(['apps/api/pupitre.json'], [], 'apps/api/pupitre.json'), true);
  });

  it('par défaut : le dossier de la spec, ou tout le dépôt si elle est à la racine', () => {
    assert.deepEqual(defaultWatchPaths('pupitre.json'), ['**']);
    assert.deepEqual(defaultWatchPaths('apps/api/pupitre.json'), ['apps/api/**']);
  });
});

describe('pupitre.json', () => {
  it('accepte une AppSpec valide au nom de l’application', () => {
    const result = parseSourceSpec(JSON.stringify(BASE), 'demo-api');
    assert.equal(result.ok, true);
  });

  it('refuse un JSON illisible, une spec invalide, un autre nom — et dit pourquoi', () => {
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

// ─── client GitHub ─────────────────────────────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** Un faux GitHub : une réponse par motif d'URL, et la trace des appels. */
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

describe('client GitHub', () => {
  it('signe un JWT d’App vérifiable, valable moins de dix minutes', () => {
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

  it('« rien de neuf » répond 304 : on le dit sans lire de corps, et l’ETag part', async () => {
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

  it('un nouveau commit : son empreinte et le nouvel ETag', async () => {
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

  it('garde le jeton d’installation tant qu’il vit : un seul échange pour deux appels', async () => {
    const { fetchImpl, calls } = fakeGitHub([
      TOKEN_ROUTE,
      [/\/commits\/main$/, () => new Response(SHA)],
    ]);
    const github = new GitHubSourceProvider({ appId: 1, privateKey }, fetchImpl);
    await github.resolveHead(REPO, 'main', null);
    await github.resolveHead(REPO, 'main', null);
    assert.equal(calls.filter((call) => call.url.includes('access_tokens')).length, 1);
  });

  it('une comparaison réécrite (force-push) ou trop longue ne se croit pas', async () => {
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
    // Commit de base introuvable : on ne sait pas, donc tout a changé.
    assert.equal((await github.compare(REPO, 'd'.repeat(40), SHA)).kind, 'unknown');
  });

  it('un fichier absent au commit vaut `null`, pas une erreur', async () => {
    const { fetchImpl } = fakeGitHub([TOKEN_ROUTE]);
    const github = new GitHubSourceProvider({ appId: 1, privateKey }, fetchImpl);
    assert.equal(await github.readFile(REPO, SHA, 'pupitre.json'), null);
  });

  it('le statut de commit : description coupée à 140 caractères, lien vers le run', async () => {
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

  it('le manifeste ne demande que lire le code et écrire les statuts, sans webhook', () => {
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
    // Un bloc webhook, même éteint, fait refuser le manifeste d'un panel privé :
    // GitHub veut que son URL soit joignable depuis Internet.
    assert.equal('hook_attributes' in manifest, false);
    assert.deepEqual(manifest.default_events, []);
    assert.equal(manifest.public, false);
  });
});
