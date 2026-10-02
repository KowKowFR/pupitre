import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderComposeFile, COMPOSE_FILE } from '../src/drivers/docker/render.js';
import { SOURCE_DIR, buildContextPath } from '../src/drivers/source-archive.js';
import { getDriver } from '../src/drivers/index.js';
import { parseAppSpec, safeParseAppSpec } from '../src/spec/index.js';

/**
 * Le code d'un dépôt lié ne se mêle jamais aux fichiers de pilotage de la
 * release. À la racine, un `compose.override.yml` du dépôt était fusionné par
 * Compose, un `.env` changeait le nom du projet, un dossier `k8s/` était
 * appliqué sur le cluster — et un contexte `../..` allait lire les autres
 * applications de la machine.
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

describe('le code d’un dépôt, à part dans la release', () => {
  it('les contextes de l’AppSpec se résolvent sous source/, relatifs à la racine du dépôt', () => {
    assert.equal(SOURCE_DIR, 'source');
    assert.equal(buildContextPath('examples/bonjour', true), 'source/examples/bonjour');
    assert.equal(buildContextPath('./app/', true), 'source/app');
    assert.equal(buildContextPath('.', true), 'source');
    // Sans dépôt, rien ne change : le contexte est fourni à la racine de la release.
    assert.equal(buildContextPath('examples/bonjour', false), 'examples/bonjour');
    assert.equal(buildContextPath('.', undefined), '.');
  });

  it('Compose construit depuis source/ quand le déploiement vient d’un dépôt', () => {
    const spec = parseAppSpec(built('examples/bonjour'));
    const fromRepo = renderComposeFile({
      spec,
      appSlug: 'bonjour',
      publishedPort: 30001,
      sourceInRelease: true,
    });
    assert.deepEqual(fromRepo.services.web?.build, {
      context: 'source/examples/bonjour',
      dockerfile: 'Dockerfile',
    });
    const bundled = renderComposeFile({ spec, appSlug: 'bonjour', publishedPort: 30001 });
    assert.equal(bundled.services.web?.build?.context, 'examples/bonjour');
    assert.equal(COMPOSE_FILE, 'compose.yml');
  });

  it('le nettoyage manuel nomme son projet et son fichier, sans rien laisser deviner à Compose', () => {
    const [down] = getDriver('docker').manualCleanup('bonjour', '/opt/bootstrap');
    assert.match(down!, /docker compose -p app-bonjour -f compose\.yml down -v/);
  });

  it('refuse un chemin de construction qui sort du code envoyé', () => {
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

describe('K3s — une image reconstruite sous la même étiquette remplace les pods', () => {
  it('le gabarit d’un service construit porte le déploiement ; une image du registre, non', async () => {
    const { renderManifests, RELEASE_ANNOTATION } = await import('../src/drivers/k3s/render.js');
    const spec = parseAppSpec({
      name: 'bonjour',
      version: '1.0.0',
      services: [
        { name: 'web', source: { type: 'dockerfile', context: 'app' }, port: 8080, exposed: true },
        { name: 'cache', source: { type: 'image', ref: 'redis:7' }, port: 6379 },
      ],
    });
    const annotations = (release: string) =>
      Object.fromEntries(
        renderManifests({ spec, appSlug: 'bonjour', release })
          .filter((manifest) => manifest.kind === 'Deployment')
          .map((manifest) => [
            manifest.metadata.name,
            (
              manifest as {
                spec: { template: { metadata: { annotations?: Record<string, string> } } };
              }
            ).spec.template.metadata.annotations?.[RELEASE_ANNOTATION] ?? null,
          ]),
      );
    assert.deepEqual(annotations('dep-1'), { web: 'dep-1', cache: null });
    // Un autre déploiement, même version, même étiquette d'image : le gabarit change.
    assert.equal(annotations('dep-2').web, 'dep-2');
  });
});

describe('K3s — la santé ne compte pas les pods qui s’en vont', () => {
  it('un pod en cours de suppression n’empêche pas la nouvelle version d’être prête', async () => {
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
