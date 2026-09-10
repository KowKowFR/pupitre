import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { parseAppSpec, type AppSpec } from '../src/spec/index.js';
import {
  networkName,
  projectName,
  renderComposeFile,
  renderFiles,
  serializeComposeFile,
} from '../src/drivers/docker/render.js';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'spec',
  '__fixtures__',
);

function fixture(name: string): AppSpec {
  return parseAppSpec(JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')));
}

const workdir = mkdtempSync(path.join(tmpdir(), 'tp-render-'));
after(() => rmSync(workdir, { recursive: true, force: true }));

let dockerAvailable = true;
try {
  execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
} catch {
  dockerAvailable = false;
}

/**
 * Fait valider le rendu par Docker lui-même. C'est la seule preuve qui compte :
 * un YAML syntaxiquement correct peut rester un Compose invalide.
 */
function validateWithDockerCompose(name: string, spec: AppSpec, publishedPort: number | null) {
  const dir = path.join(workdir, name);
  mkdirSync(dir, { recursive: true });

  for (const file of renderFiles({ spec, appSlug: spec.name, publishedPort })) {
    writeFileSync(path.join(dir, file.path), file.content);
  }

  // Les contextes de build doivent exister pour que `config` les résolve.
  for (const service of spec.services) {
    if (service.source.type !== 'dockerfile') continue;
    const context = path.join(dir, service.source.context);
    mkdirSync(path.dirname(path.join(context, service.source.dockerfile)), { recursive: true });
    writeFileSync(path.join(context, service.source.dockerfile), 'FROM scratch\n');
  }

  return execFileSync('docker', ['compose', '-f', path.join(dir, 'compose.yml'), 'config'], {
    encoding: 'utf8',
    cwd: dir,
  });
}

describe('render() — AppSpec vers Compose', () => {
  describe('simple.json', () => {
    const spec = fixture('simple');
    const file = renderComposeFile({ spec, appSlug: spec.name, publishedPort: 30001 });

    it('nomme le projet app-{slug} et son réseau', () => {
      assert.equal(file.name, 'app-demo-api');
      assert.equal(projectName('demo-api'), 'app-demo-api');
      assert.equal(file.networks?.appnet?.name, networkName('demo-api'));
      assert.equal(file.networks?.appnet?.driver, 'bridge');
    });

    it('publie le port du service exposé', () => {
      assert.deepEqual(file.services.api?.ports, ['30001:80']);
      assert.deepEqual(file.services.api?.expose, ['80']);
    });

    it('décide de la politique de redémarrage, absente de la spec', () => {
      assert.equal(file.services.api?.restart, 'unless-stopped');
    });

    it('traduit les ressources en limites Compose', () => {
      assert.equal(file.services.api?.deploy?.resources?.limits?.cpus, '0.500');
      assert.equal(file.services.api?.deploy?.resources?.limits?.memory, '256M');
    });

    it('produit un compose.yml validé par Docker', { skip: !dockerAvailable }, () => {
      const output = validateWithDockerCompose('simple', spec, 30001);
      const parsed = parseYaml(output) as { name?: string; services?: Record<string, unknown> };
      assert.equal(parsed.name, 'app-demo-api');
      assert.ok(parsed.services?.api);
    });
  });

  describe('fullstack.json', () => {
    const spec = fixture('fullstack');
    const file = renderComposeFile({ spec, appSlug: spec.name, publishedPort: null });

    it('range les services dans l’ordre des dépendances', () => {
      assert.deepEqual(Object.keys(file.services), ['postgres', 'api', 'front']);
    });

    it('traduit dependsOn en depends_on conditionnel', () => {
      assert.deepEqual(file.services.api?.depends_on, {
        postgres: { condition: 'service_healthy' },
      });
      assert.deepEqual(file.services.front?.depends_on, {
        api: { condition: 'service_healthy' },
      });
    });

    it('construit les services à Dockerfile et taggue leur image', () => {
      assert.deepEqual(file.services.api?.build, {
        context: './api',
        dockerfile: 'docker/Dockerfile',
      });
      assert.equal(file.services.api?.image, 'app-boutique/api:2.3.1');
      assert.equal(file.services.postgres?.image, 'postgres:16-alpine', 'image tirée telle quelle');
      assert.equal(file.services.postgres?.build, undefined);
    });

    it('préfixe les volumes nommés pour éviter les collisions', () => {
      assert.deepEqual(file.services.postgres?.volumes, [
        'app-boutique-postgres-data:/var/lib/postgresql/data',
      ]);
      assert.ok(file.volumes?.['app-boutique-postgres-data']);
      assert.ok(file.volumes?.['app-boutique-api-uploads']);
    });

    it('n’inscrit jamais la valeur d’un secret dans le compose.yml', () => {
      const yaml = serializeComposeFile(file);
      for (const secret of ['DATABASE_PASSWORD', 'JWT_SECRET', 'POSTGRES_PASSWORD']) {
        assert.ok(!yaml.includes(`${secret}:`), `${secret} ne doit pas être une clé du compose`);
      }
      assert.deepEqual(file.services.api?.env_file, ['./.env']);
      assert.equal(file.services.front?.env_file, undefined, 'front ne déclare aucun secret');
    });

    it('génère un .env en 0600 avec les noms déclarés', () => {
      const files = renderFiles({ spec, appSlug: spec.name, publishedPort: null });
      const env = files.find((f) => f.path === '.env');
      assert.ok(env);
      assert.equal(env.mode, 0o600);
      for (const secret of ['DATABASE_PASSWORD', 'JWT_SECRET', 'POSTGRES_PASSWORD']) {
        assert.match(env.content, new RegExp(`^${secret}=`, 'm'));
      }
    });

    it('ne publie aucun port quand le service exposé a plusieurs répliques', () => {
      assert.equal(file.services.front?.ports, undefined);
      assert.equal(file.services.front?.deploy?.replicas, 2);
    });

    it('sonde le service exposé en HTTP, les autres en TCP', () => {
      const front = file.services.front?.healthcheck?.test.join(' ') ?? '';
      assert.match(front, /wget --spider .*\/healthz/);
      const postgres = file.services.postgres?.healthcheck?.test.join(' ') ?? '';
      assert.match(postgres, /nc -z 127\.0\.0\.1 5432/);
    });

    it('produit un compose.yml validé par Docker', { skip: !dockerAvailable }, () => {
      const output = validateWithDockerCompose('fullstack', spec, null);
      const parsed = parseYaml(output) as { services?: Record<string, unknown> };
      assert.deepEqual(Object.keys(parsed.services ?? {}).sort(), ['api', 'front', 'postgres']);
    });
  });

  describe('sérialisation', () => {
    it('échappe ce qu’une concaténation de chaînes casserait', () => {
      const spec = parseAppSpec({
        name: 'echappement',
        version: '1.0.0',
        services: [
          {
            name: 'web',
            source: { type: 'image', ref: 'nginx:alpine' },
            port: 80,
            exposed: true,
            env: {
              QUOTED: 'valeur avec "guillemets" et \'apostrophes\'',
              MULTILINE: 'première ligne\nseconde ligne',
              YAML_TRAP: '*ancre: &pas-une-ancre',
              COLON: 'clé: valeur',
            },
          },
        ],
      });

      const yaml = serializeComposeFile(renderComposeFile({ spec, appSlug: 'echappement', publishedPort: 30002 }));
      const parsed = parseYaml(yaml) as {
        services: { web: { environment: Record<string, string> } };
      };

      assert.equal(parsed.services.web.environment.QUOTED, 'valeur avec "guillemets" et \'apostrophes\'');
      assert.equal(parsed.services.web.environment.MULTILINE, 'première ligne\nseconde ligne');
      assert.equal(parsed.services.web.environment.YAML_TRAP, '*ancre: &pas-une-ancre');
      assert.equal(parsed.services.web.environment.COLON, 'clé: valeur');
    });

    it('reste déterministe', () => {
      const spec = fixture('fullstack');
      const once = serializeComposeFile(renderComposeFile({ spec, appSlug: spec.name, publishedPort: 30003 }));
      const twice = serializeComposeFile(renderComposeFile({ spec, appSlug: spec.name, publishedPort: 30003 }));
      assert.equal(once, twice);
    });
  });
});
