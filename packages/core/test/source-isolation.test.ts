import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderComposeFile, COMPOSE_FILE } from '../src/drivers/docker/render.js';
import { SOURCE_DIR, buildContextPath } from '../src/drivers/source-archive.js';
import { getDriver } from '../src/drivers/index.js';
import { parseAppSpec, safeParseAppSpec } from '../src/spec/index.js';

/**
 * A linked repository's code never mixes with the release's control files. At
 * the root, a `compose.override.yml` from the repository was merged by Compose,
 * a `.env` changed the project's name, a `k8s/` folder was applied to the
 * cluster — and a `../..` context went and read the machine's other
 * applications.
 */

const built = (context: string, dockerfile = 'Dockerfile') => ({
  name: 'bonjour',
  version: '1.0.0',
  services: [
    {
      name: 'web',
      source: { type: 'dockerfile', context, dockerfile },
      port: 8080,
      exposed: true,
    },
  ],
});

describe('a repository’s code, apart in the release', () => {
  it('the AppSpec’s contexts resolve under source/, relative to the repository’s root', () => {
    assert.equal(SOURCE_DIR, 'source');
    assert.equal(buildContextPath('examples/bonjour', true), 'source/examples/bonjour');
    assert.equal(buildContextPath('./app/', true), 'source/app');
    assert.equal(buildContextPath('.', true), 'source');
    // Without a repository, nothing changes: the context is provided at the
    // release's root.
    assert.equal(buildContextPath('examples/bonjour', false), 'examples/bonjour');
    assert.equal(buildContextPath('.', undefined), '.');
  });

  it('Compose builds from source/ when the deployment comes from a repository', () => {
    const spec = parseAppSpec(built('examples/bonjour'));
    const fromRepo = renderComposeFile({
      language: 'fr',
      spec,
      appSlug: 'bonjour',
      publishedPort: 30001,
      sourceInRelease: true,
    });
    assert.deepEqual(fromRepo.services.web?.build, {
      context: 'source/examples/bonjour',
      dockerfile: 'Dockerfile',
    });
    const bundled = renderComposeFile({
      language: 'fr',
      spec,
      appSlug: 'bonjour',
      publishedPort: 30001,
    });
    assert.equal(bundled.services.web?.build?.context, 'examples/bonjour');
    assert.equal(COMPOSE_FILE, 'compose.yml');
  });

  it('the manual cleanup names its project and its file, leaving nothing for Compose to guess', () => {
    const [down] = getDriver('docker').manualCleanup('bonjour', '/opt/bootstrap');
    assert.match(down!, /docker compose -p app-bonjour -f compose\.yml down -v/);
  });

  it('refuses a build path that leaves the uploaded code', () => {
    for (const context of ['../autre-app', 'app/../../..', '/etc', 'a\\..\\..\\b']) {
      assert.equal(safeParseAppSpec(built(context)).success, false, context);
    }
    assert.equal(safeParseAppSpec(built('app', '../Dockerfile')).success, false);
    assert.equal(safeParseAppSpec(built('app', '/Dockerfile')).success, false);
    for (const context of ['.', 'examples/bonjour', './app', 'apps/web']) {
      assert.equal(safeParseAppSpec(built(context, 'docker/Dockerfile')).success, true, context);
    }
  });
});

describe('one release per deployment — going back finds the right code', () => {
  it('names the release by the version and the deployment number, image tag included', async () => {
    const { releaseName, releaseCandidates } = await import('../src/drivers/release.js');
    assert.equal(releaseName({ version: '1.0.0', sequence: 12 }), '1.0.0-r12');
    // A semver version's `+` is not allowed in an image tag.
    assert.equal(releaseName({ version: '1.0.0+build.7', sequence: 3 }), '1.0.0-build.7-r3');
    // A release from before this naming is found under the version alone.
    assert.deepEqual(releaseCandidates({ version: '1.0.0', sequence: 12 }), ['1.0.0-r12', '1.0.0']);
  });

  it('two deployments of the same version: two images, on both runtimes', async () => {
    const { renderManifests } = await import('../src/drivers/k3s/render.js');
    const spec = parseAppSpec({
      name: 'bonjour',
      version: '1.0.0',
      services: [
        { name: 'web', source: { type: 'dockerfile', context: 'app' }, port: 8080, exposed: true },
        { name: 'cache', source: { type: 'image', ref: 'redis:7' }, port: 6379 },
      ],
    });
    const images = (imageTag: string) =>
      Object.fromEntries(
        renderManifests({ language: 'fr', spec, appSlug: 'bonjour', imageTag })
          .filter((manifest) => manifest.kind === 'Deployment')
          .map((manifest) => [
            manifest.metadata.name,
            (manifest as { spec: { template: { spec: { containers: Array<{ image: string }> } } } })
              .spec.template.spec.containers[0]?.image,
          ]),
      );
    assert.deepEqual(images('1.0.0-r1'), { web: 'app-bonjour/web:1.0.0-r1', cache: 'redis:7' });
    assert.equal(images('1.0.0-r2').web, 'app-bonjour/web:1.0.0-r2');

    const compose = renderComposeFile({
      language: 'fr',
      spec,
      appSlug: 'bonjour',
      publishedPort: 30001,
      imageTag: '1.0.0-r2',
    });
    assert.equal(compose.services.web?.image, 'app-bonjour/web:1.0.0-r2');
    assert.equal(compose.services.cache?.image, 'redis:7');
  });
});

describe('K3s — health does not count the pods that are leaving', () => {
  it('a pod being deleted does not prevent the new version from being ready', async () => {
    const { parsePodReadiness } = await import('../src/drivers/k3s/driver.js');
    const ready = { type: 'Ready', status: 'True' };
    const output = JSON.stringify({
      items: [
        { metadata: { name: 'web-neuf' }, status: { phase: 'Running', conditions: [ready] } },
        {
          metadata: { name: 'web-epave', deletionTimestamp: '2026-10-01T16:50:00Z' },
          status: { phase: 'Pending', conditions: [{ type: 'Ready', status: 'False' }] },
        },
      ],
    });
    assert.deepEqual(parsePodReadiness(output), { total: 1, ready: 1, pending: [] });
  });
});
