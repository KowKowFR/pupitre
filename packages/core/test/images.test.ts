import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { parseRepoDigests } from '../src/drivers/docker/driver.js';
import { parsePodImages, pulledDigest } from '../src/drivers/k3s/driver.js';
import {
  RegistryError,
  createRegistryClient,
  nextPage,
  parseBearerChallenge,
} from '../src/images/registry.js';
import {
  buildNotificationMessage,
  canonicalImageReference,
  checkableImages,
  digestOf,
  formatImageReference,
  judgeImage,
  newerTags,
  notifiableEventFor,
  notificationDedupDiscriminator,
  parseAppSpec,
  parseImageReference,
  shortDigest,
  updateNoticeKey,
} from '../src/index.js';

/**
 * Image updates: read a reference as Docker reads it, ask the registry what the
 * tag designates, compare with what runs, and only announce it once.
 */

const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;

describe('image references', () => {
  it('read as Docker reads them', () => {
    assert.deepEqual(parseImageReference('nginx'), {
      registry: 'registry-1.docker.io',
      repository: 'library/nginx',
      tag: 'latest',
      digest: null,
    });
    assert.deepEqual(parseImageReference('bitnami/redis:7.2'), {
      registry: 'registry-1.docker.io',
      repository: 'bitnami/redis',
      tag: '7.2',
      digest: null,
    });
    assert.deepEqual(parseImageReference('ghcr.io/acme/api:2.1.0'), {
      registry: 'ghcr.io',
      repository: 'acme/api',
      tag: '2.1.0',
      digest: null,
    });
    assert.deepEqual(parseImageReference('localhost:5000/app'), {
      registry: 'localhost:5000',
      repository: 'app',
      tag: 'latest',
      digest: null,
    });
    assert.equal(parseImageReference(`docker.io/library/postgres:16@${A}`)?.digest, A);
    assert.equal(
      parseImageReference('docker.io/library/postgres:16')?.registry,
      'registry-1.docker.io',
    );
  });

  it('refuses what is not one', () => {
    for (const raw of [
      '',
      'Nginx',
      'nginx:',
      'nginx@sha256:court',
      'a b',
      'nginx:tag with space',
    ]) {
      assert.equal(parseImageReference(raw), null, raw);
    }
  });

  it('are rewritten, and digests are read in all their forms', () => {
    assert.equal(formatImageReference(parseImageReference('nginx:1.27')!), 'nginx:1.27');
    assert.equal(
      formatImageReference(parseImageReference('ghcr.io/acme/api')!),
      'ghcr.io/acme/api:latest',
    );
    assert.equal(digestOf(`nginx@${A}`), A);
    assert.equal(digestOf(`docker.io/library/nginx@${A}`), A);
    assert.equal(digestOf(A), A);
    assert.equal(digestOf('sha256:pas-un-digest'), null);
    assert.equal(shortDigest(A), 'aaaaaaaaaaaa');
  });
});

describe('verdict and versions', () => {
  it('up to date only if everything running is the tag’s current content', () => {
    assert.equal(judgeImage({ pinned: false, running: [A], latest: A }), 'current');
    assert.equal(judgeImage({ pinned: false, running: [B], latest: A }), 'outdated');
    // A half-done rollout is not up to date.
    assert.equal(judgeImage({ pinned: false, running: [A, B], latest: A }), 'outdated');
    assert.equal(judgeImage({ pinned: false, running: [], latest: A }), 'unknown');
    assert.equal(judgeImage({ pinned: false, running: [A], latest: null }), 'unknown');
    assert.equal(judgeImage({ pinned: true, running: [A], latest: null }), 'pinned');
  });

  it('offers a more recent tag of the same shape, series and major apart', () => {
    const tags = [
      '16.4',
      '16.6',
      '16.10',
      '17.2',
      '17.0',
      '16.6-alpine',
      '18beta1',
      'latest',
      '16',
    ];
    assert.deepEqual(newerTags('16.4', tags), { sameSeries: '16.10', nextMajor: '17.2' });
    assert.deepEqual(newerTags('16.4-alpine', ['16.6-alpine', '16.6', '17.1-alpine']), {
      sameSeries: '16.6-alpine',
      nextMajor: '17.1-alpine',
    });
    // A single component: there is no "same series", only majors.
    assert.deepEqual(newerTags('16', tags), { sameSeries: null, nextMajor: null });
    assert.deepEqual(newerTags('16', ['17', '18', '16.9']), { sameSeries: null, nextMajor: '18' });
    assert.deepEqual(newerTags('v1.2.3', ['v1.2.4', '1.2.9', 'v2.0.0']), {
      sameSeries: 'v1.2.4',
      nextMajor: 'v2.0.0',
    });
    assert.deepEqual(newerTags('latest', tags), { sameSeries: null, nextMajor: null });
    assert.deepEqual(newerTags('16.10', tags), { sameSeries: null, nextMajor: '17.2' });
  });

  it('only announces something new once', () => {
    const first = updateNoticeKey({ status: 'outdated', latestDigest: A, sameSeries: null });
    assert.equal(first, A);
    assert.equal(updateNoticeKey({ status: 'outdated', latestDigest: A, sameSeries: null }), first);
    assert.equal(updateNoticeKey({ status: 'current', latestDigest: A, sameSeries: null }), null);
    assert.equal(
      updateNoticeKey({ status: 'current', latestDigest: A, sameSeries: '16.6' }),
      'tag:16.6',
    );
  });

  it('only checks the images coming from a registry', () => {
    const spec = parseAppSpec({
      name: 'mix',
      version: '1.0.0',
      services: [
        { name: 'web', source: { type: 'image', ref: 'nginx:1.27' }, port: 80, exposed: true },
        {
          name: 'api',
          source: { type: 'dockerfile', context: '.', dockerfile: 'Dockerfile' },
          port: 3000,
        },
      ],
    });
    assert.deepEqual(
      checkableImages(spec).map((image) => image.service),
      ['web'],
    );
  });
});

describe('registre', () => {
  it('reads the authentication challenge and the pagination', () => {
    assert.deepEqual(
      parseBearerChallenge(
        'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"',
      ),
      {
        realm: 'https://auth.docker.io/token',
        service: 'registry.docker.io',
        scope: 'repository:library/nginx:pull',
      },
    );
    assert.equal(parseBearerChallenge('Basic realm="x"'), null);
    assert.equal(
      nextPage('</v2/library/postgres/tags/list?last=17.5&n=1000>; rel="next"'),
      '/v2/library/postgres/tags/list?last=17.5&n=1000',
    );
    assert.equal(nextPage(null), null);
  });

  type Seen = { url: string; method: string; auth: string | null };

  function fakeRegistry(handler: (url: URL, init: RequestInit) => Response) {
    const seen: Seen[] = [];
    const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const headers = (init.headers ?? {}) as Record<string, string>;
      seen.push({
        url: url.toString(),
        method: init.method ?? 'GET',
        auth: headers.authorization ?? null,
      });
      return handler(url, init);
    }) as typeof fetch;
    return { seen, client: createRegistryClient({ fetch: fetcher, maxTagPages: 3 }) };
  }

  const challenge = {
    'www-authenticate':
      'Bearer realm="https://auth.example.test/token",service="reg",scope="repository:library/nginx:pull"',
  };

  it('gets an anonymous token then the digest, without downloading anything', async () => {
    const { seen, client } = fakeRegistry((url, init) => {
      if (url.host === 'auth.example.test') return Response.json({ token: 'jeton' });
      const headers = init.headers as Record<string, string>;
      if (!headers.authorization) return new Response(null, { status: 401, headers: challenge });
      return new Response(null, { status: 200, headers: { 'docker-content-digest': A } });
    });
    const ref = parseImageReference('nginx:alpine')!;
    assert.equal(await client.manifestDigest(ref), A);
    // The token is reused: a single round trip to the token server.
    assert.equal(await client.manifestDigest(ref), A);
    assert.equal(seen.filter((call) => call.url.startsWith('https://auth.example.test')).length, 1);
    assert.ok(seen.every((call) => call.method !== 'GET' || call.url.includes('/token')));
    assert.equal(seen.at(-1)?.auth, 'Bearer jeton');
  });

  it('computes the digest when the registry does not announce it', async () => {
    const manifest = Buffer.from('{"schemaVersion":2}');
    const { client } = fakeRegistry((_url, init) =>
      init.method === 'HEAD' ? new Response(null, { status: 200 }) : new Response(manifest),
    );
    const expected = `sha256:${createHash('sha256').update(manifest).digest('hex')}`;
    assert.equal(await client.manifestDigest(parseImageReference('ghcr.io/acme/api:1')!), expected);
  });

  it('says why it does not know', async () => {
    const cases: Array<[Response, string]> = [
      [new Response(null, { status: 404 }), 'not_found'],
      [new Response(null, { status: 429 }), 'rate_limited'],
      [new Response(null, { status: 403 }), 'unauthorized'],
      [new Response(null, { status: 500 }), 'unexpected'],
    ];
    for (const [response, code] of cases) {
      const { client } = fakeRegistry(() => response.clone());
      await assert.rejects(
        client.manifestDigest(parseImageReference('nginx')!),
        (error: unknown) => error instanceof RegistryError && error.code === code,
      );
    }
    // A clear-text token server is not followed.
    const { client } = fakeRegistry(
      () =>
        new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer realm="http://169.254.169.254/token"' },
        }),
    );
    await assert.rejects(client.manifestDigest(parseImageReference('nginx')!), RegistryError);
  });

  it('follows the tags pagination, bounded, without leaving the registry', async () => {
    let page = 0;
    const { client, seen } = fakeRegistry(() => {
      page += 1;
      return Response.json(
        { tags: [`1.${page}`] },
        {
          headers: {
            link:
              page === 2
                ? '<https://ailleurs.example/v2/x/tags/list?last=1.2>; rel="next"'
                : `</v2/library/nginx/tags/list?last=1.${page}&n=1000>; rel="next"`,
          },
        },
      );
    });
    assert.deepEqual(await client.listTags(parseImageReference('nginx')!), ['1.1', '1.2']);
    assert.ok(seen.every((call) => call.url.startsWith('https://registry-1.docker.io/')));
  });
});

describe('what runs, as seen by each runtime', () => {
  it('Docker: RepoDigests per image identifier', () => {
    const digests = parseRepoDigests(
      [
        `sha256:111 ["nginx@${A}"]`,
        'sha256:222 []',
        'ligne illisible',
        `sha256:333 ["a@${B}","b@${A}"]`,
      ].join('\n'),
    );
    assert.deepEqual(digests.get('sha256:111'), [A]);
    assert.deepEqual(digests.get('sha256:222'), []);
    assert.deepEqual(digests.get('sha256:333'), [B, A]);
  });

  it('K3s: the pods’ imageID, per service', () => {
    const pods = JSON.stringify({
      items: [
        {
          metadata: { labels: { 'app.kubernetes.io/name': 'web' } },
          status: { containerStatuses: [{ name: 'web', imageID: `docker.io/library/nginx@${A}` }] },
        },
        {
          metadata: { labels: { 'app.kubernetes.io/name': 'web' } },
          status: { containerStatuses: [{ name: 'web', imageID: `docker.io/library/nginx@${B}` }] },
        },
        { metadata: { labels: {} }, status: {} },
      ],
    });
    assert.deepEqual(parsePodImages(pods), [{ service: 'web', digests: [A, B] }]);
  });

  it('K3s: the pulled digest, for the requested repository', () => {
    const inspect = JSON.stringify({
      status: { repoDigests: [`docker.io/other/mirror@${B}`, `docker.io/library/nginx@${A}`] },
    });
    assert.equal(pulledDigest(inspect, 'nginx:alpine'), A);
    assert.equal(pulledDigest('pas du json', 'nginx'), null);
  });
});

describe('“image.update.available” notification', () => {
  const entry = {
    action: 'image.update.available',
    resourceType: 'application',
    resourceId: '22222222-2222-2222-2222-222222222222',
    actorId: null,
    before: null,
    after: {
      application: 'blog',
      applicationName: 'Blog',
      targetName: 'prod-1',
      noticeKey: `${A},tag:16.6`,
      images: [
        { service: 'web', image: 'nginx:alpine', status: 'outdated' },
        { service: 'db', image: 'postgres:16.4', status: 'current', newerTag: '16.6' },
      ],
    },
  };

  it('goes out from the audit log, and stands out by its novelty', () => {
    assert.equal(notifiableEventFor(entry), 'image.update.available');
    assert.equal(notificationDedupDiscriminator('image.update.available', entry), `${A},tag:16.6`);
  });

  for (const language of ['fr', 'en'] as const) {
    it(`renders in ${language}, without a forgotten reason`, () => {
      const message = buildNotificationMessage('image.update.available', entry, {
        language,
        instance: 'Recette',
        panelUrl: 'https://panel.example.test',
        actor: null,
        occurredAt: '2026-10-01T10:00:00.000Z',
      });
      const text = [
        message.title,
        message.body,
        ...message.fields.map((field) => field.value),
      ].join(' ');
      assert.doesNotMatch(text, /\{\w+\}/);
      assert.match(text, /nginx:alpine \(web\)/);
      assert.match(text, /postgres:16\.4 → 16\.6 \(db\)/);
      assert.equal(
        message.url,
        'https://panel.example.test/applications/22222222-2222-2222-2222-222222222222',
      );
      assert.equal(message.severity, 'warning');
    });
  }
});

describe('canonicalImageReference — the name containerd records', () => {
  it('completes Docker Hub, keeps the other registries, pins the digest', () => {
    assert.equal(canonicalImageReference('nginx:1.27'), 'docker.io/library/nginx:1.27');
    assert.equal(canonicalImageReference('nginx'), 'docker.io/library/nginx:latest');
    assert.equal(
      canonicalImageReference('app-bonjour/web:1.0.0-r2'),
      'docker.io/app-bonjour/web:1.0.0-r2',
    );
    assert.equal(
      canonicalImageReference('docker.io/app-bonjour/web:1'),
      'docker.io/app-bonjour/web:1',
    );
    assert.equal(canonicalImageReference('ghcr.io/acme/api:2.1'), 'ghcr.io/acme/api:2.1');
    assert.equal(canonicalImageReference('localhost:5000/app'), 'localhost:5000/app:latest');
    const digest = `sha256:${'a'.repeat(64)}`;
    assert.equal(
      canonicalImageReference(`postgres:16@${digest}`),
      `docker.io/library/postgres@${digest}`,
    );
    assert.equal(canonicalImageReference('pas une image'), 'pas une image');
  });
});
