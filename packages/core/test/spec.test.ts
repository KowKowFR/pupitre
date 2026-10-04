import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  findDependencyCycle,
  parseAppSpec,
  safeParseAppSpec,
  exposedService,
  secretBindings,
  secretNamesOf,
  secretRootName,
  storedSecretNames,
  topologicalOrder,
} from '../src/spec/index.js';
import { completeSecretValues } from '../src/drivers/secrets.js';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'spec',
  '__fixtures__',
);

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
}

describe('AppSpec', () => {
  describe('fixtures valides', () => {
    it('simple.json is accepted and gets its defaults', () => {
      const spec = parseAppSpec(loadFixture('simple'));
      assert.equal(spec.name, 'demo-api');
      assert.equal(spec.services.length, 1);

      const [service] = spec.services;
      assert.ok(service);
      assert.equal(service.replicas, 1, 'replicas defaults to 1');
      assert.deepEqual(service.secrets, []);
      assert.deepEqual(service.volumes, []);
      assert.deepEqual(service.dependsOn, []);
      assert.equal(service.resources.cpuMilli, 500);
    });

    it('fullstack.json is accepted with volumes, secrets and dependsOn', () => {
      const spec = parseAppSpec(loadFixture('fullstack'));
      assert.equal(spec.services.length, 3);
      assert.equal(exposedService(spec).name, 'front');
      assert.equal(spec.ingress?.targetService, 'front');
      assert.equal(spec.ingress?.tls, true);

      const api = spec.services.find((s) => s.name === 'api');
      assert.ok(api);
      assert.deepEqual(api.dependsOn, ['postgres']);
      assert.deepEqual(api.secrets, ['DATABASE_PASSWORD', 'JWT_SECRET']);
      assert.equal(api.volumes[0]?.size, '5Gi');
    });

    it('orders the services by dependency', () => {
      const spec = parseAppSpec(loadFixture('fullstack'));
      const order = topologicalOrder(spec).map((s) => s.name);
      assert.ok(
        order.indexOf('postgres') < order.indexOf('api'),
        `postgres must come before api: ${order.join(' → ')}`,
      );
      assert.ok(order.indexOf('api') < order.indexOf('front'));
    });
  });

  describe('invalid.json is rejected', () => {
    const result = safeParseAppSpec(loadFixture('invalid'));

    it('fails globally', () => {
      assert.equal(result.success, false);
    });

    const messages = result.success
      ? []
      : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);

    const expectations: Array<[string, RegExp]> = [
      ['nom non slug-safe', /name/],
      ['version non semver', /version/],
      ['noms de services dupliqués', /dupliqu/i],
      ['plusieurs services exposed', /exposed/i],
      ['dépendance inconnue', /service inconnu/i],
      ['ingress vers un service inexistant', /l'ingress cible le service inconnu/i],
    ];

    for (const [label, pattern] of expectations) {
      it(`signale : ${label}`, () => {
        assert.ok(
          messages.some((message) => pattern.test(message)),
          `no message matches ${pattern}\nmessages: ${messages.join(' | ')}`,
        );
      });
    }
  });

  describe('refinements', () => {
    const base = {
      name: 'app',
      version: '1.0.0',
      services: [
        { name: 'web', source: { type: 'image', ref: 'nginx' }, port: 80, exposed: true },
      ],
    };

    it('requires at least one service', () => {
      assert.equal(safeParseAppSpec({ ...base, services: [] }).success, false);
    });

    it('requires exactly one exposed service — zero fails', () => {
      const result = safeParseAppSpec({
        ...base,
        services: [{ ...base.services[0], exposed: false }],
      });
      assert.equal(result.success, false);
      assert.match(
        result.success ? '' : result.error.issues.map((i) => i.message).join(' '),
        /aucun ne le fait/,
      );
    });

    it('requires exactly one exposed service — two fail', () => {
      const result = safeParseAppSpec({
        ...base,
        services: [
          base.services[0],
          { name: 'autre', source: { type: 'image', ref: 'nginx' }, port: 81, exposed: true },
        ],
      });
      assert.equal(result.success, false);
      assert.match(
        result.success ? '' : result.error.issues.map((i) => i.message).join(' '),
        /2 le font/,
      );
    });

    it('refuses a service that depends on itself', () => {
      const result = safeParseAppSpec({
        ...base,
        services: [{ ...base.services[0], dependsOn: ['web'] }],
      });
      assert.equal(result.success, false);
      assert.match(
        result.success ? '' : result.error.issues.map((i) => i.message).join(' '),
        /ne peut pas dépendre de lui-même/,
      );
    });

    it('detects an indirect cycle front → api → cache → front', () => {
      const result = safeParseAppSpec({
        name: 'app',
        version: '1.0.0',
        services: [
          { name: 'front', source: { type: 'image', ref: 'x' }, port: 3000, exposed: true, dependsOn: ['api'] },
          { name: 'api', source: { type: 'image', ref: 'x' }, port: 8080, dependsOn: ['cache'] },
          { name: 'cache', source: { type: 'image', ref: 'x' }, port: 6379, dependsOn: ['front'] },
        ],
      });
      assert.equal(result.success, false);
      assert.match(
        result.success ? '' : result.error.issues.map((i) => i.message).join(' '),
        /cycle de dépendances/,
      );
    });

    it('accepts a diamond graph, which is not a cycle', () => {
      const result = safeParseAppSpec({
        name: 'app',
        version: '1.0.0',
        services: [
          { name: 'front', source: { type: 'image', ref: 'x' }, port: 3000, exposed: true, dependsOn: ['api', 'worker'] },
          { name: 'api', source: { type: 'image', ref: 'x' }, port: 8080, dependsOn: ['store'] },
          { name: 'worker', source: { type: 'image', ref: 'x' }, port: 9000, dependsOn: ['store'] },
          { name: 'store', source: { type: 'image', ref: 'x' }, port: 5432 },
        ],
      });
      assert.equal(
        result.success,
        true,
        result.success ? '' : result.error.issues.map((i) => i.message).join(' | '),
      );
    });

    it('refuses a key declared both in env and as a secret', () => {
      const result = safeParseAppSpec({
        ...base,
        services: [{ ...base.services[0], env: { TOKEN: 'x' }, secrets: ['TOKEN'] }],
      });
      assert.equal(result.success, false);
    });

    it('findDependencyCycle returns the cycle found', () => {
      const cycle = findDependencyCycle([
        { name: 'api', dependsOn: ['cache'] },
        { name: 'cache', dependsOn: ['api'] },
      ]);
      assert.deepEqual(cycle, ['api', 'cache', 'api']);
    });
  });

  /**
   * Two images, a single password, two variable names. It is the case of
   * WordPress + MariaDB and of GLPI + MariaDB, and it was broken by construction:
   * the store drew one value per name.
   */
  describe('secrets shared by alias', () => {
    /** The skeleton of the generation prompt's canonical example. */
    function pair(secrets: {
      app: readonly unknown[];
      db: readonly unknown[];
    }): Record<string, unknown> {
      return {
        name: 'boutique',
        version: '1.0.0',
        services: [
          {
            name: 'web',
            source: { type: 'image', ref: 'wordpress:6-apache' },
            port: 80,
            exposed: true,
            secrets: secrets.app,
            dependsOn: ['mariadb'],
          },
          {
            name: 'mariadb',
            source: { type: 'image', ref: 'mariadb:11' },
            port: 3306,
            secrets: secrets.db,
          },
        ],
      };
    }

    it('reads an old AppSpec back, with bare strings', () => {
      const spec = parseAppSpec(
        pair({ app: ['WORDPRESS_DB_PASSWORD'], db: ['MARIADB_PASSWORD'] }),
      );
      assert.deepEqual(spec.services[0]?.secrets, ['WORDPRESS_DB_PASSWORD']);
      // Two roots: it is indeed the original failure, and it stays readable.
      assert.deepEqual(storedSecretNames(spec).sort(), [
        'MARIADB_PASSWORD',
        'WORDPRESS_DB_PASSWORD',
      ]);
    });

    it('accepts an alias and only counts one root', () => {
      const spec = parseAppSpec(
        pair({
          app: [{ name: 'WORDPRESS_DB_PASSWORD', from: 'MARIADB_PASSWORD' }],
          db: ['MARIADB_PASSWORD', 'MARIADB_ROOT_PASSWORD'],
        }),
      );
      assert.deepEqual(secretNamesOf(spec).sort(), [
        'MARIADB_PASSWORD',
        'MARIADB_ROOT_PASSWORD',
        'WORDPRESS_DB_PASSWORD',
      ]);
      assert.deepEqual(storedSecretNames(spec).sort(), [
        'MARIADB_PASSWORD',
        'MARIADB_ROOT_PASSWORD',
      ]);
      assert.equal(
        secretRootName(secretBindings(spec), 'WORDPRESS_DB_PASSWORD'),
        'MARIADB_PASSWORD',
      );
    });

    it('follows an alias chain up to the root', () => {
      const spec = parseAppSpec(
        pair({
          app: [
            { name: 'A', from: 'B' },
            { name: 'B', from: 'MARIADB_PASSWORD' },
          ],
          db: ['MARIADB_PASSWORD'],
        }),
      );
      assert.deepEqual(storedSecretNames(spec), ['MARIADB_PASSWORD']);
      assert.equal(secretRootName(secretBindings(spec), 'A'), 'MARIADB_PASSWORD');
    });

    it('refuses an alias to a nonexistent secret, naming it', () => {
      const result = safeParseAppSpec(
        pair({ app: [{ name: 'WORDPRESS_DB_PASSWORD', from: 'ABSENT' }], db: [] }),
      );
      assert.equal(result.success, false);
      assert.match(
        result.success ? '' : result.error.issues.map((i) => i.message).join(' '),
        /secret inconnu « ABSENT »/,
      );
    });

    it('refuses an alias to itself', () => {
      const result = safeParseAppSpec(
        pair({ app: [{ name: 'PASSWORD', from: 'PASSWORD' }], db: [] }),
      );
      assert.equal(result.success, false);
      assert.match(
        result.success ? '' : result.error.issues.map((i) => i.message).join(' '),
        /ne peut pas prendre sa valeur de lui-même/,
      );
    });

    it('refuses two aliases pointing at each other', () => {
      const result = safeParseAppSpec(
        pair({ app: [{ name: 'A', from: 'B' }], db: [{ name: 'B', from: 'A' }] }),
      );
      assert.equal(result.success, false);
      assert.match(
        result.success ? '' : result.error.issues.map((i) => i.message).join(' '),
        /cycle d'alias de secrets/,
      );
    });

    it('refuses a name declared bare here and aliased elsewhere', () => {
      const result = safeParseAppSpec(
        pair({
          app: [{ name: 'MARIADB_PASSWORD', from: 'AUTRE' }],
          db: ['MARIADB_PASSWORD', 'AUTRE'],
        }),
      );
      assert.equal(result.success, false);
      assert.match(
        result.success ? '' : result.error.issues.map((i) => i.message).join(' '),
        /déclaré nu ici et comme alias/,
      );
    });

    it('refuses two contradictory aliases for the same name', () => {
      const result = safeParseAppSpec(
        pair({
          app: [{ name: 'P', from: 'X' }],
          db: [{ name: 'P', from: 'Y' }, 'X', 'Y'],
        }),
      );
      assert.equal(result.success, false);
      assert.match(
        result.success ? '' : result.error.issues.map((i) => i.message).join(' '),
        /un nom ne désigne qu'une valeur/,
      );
    });

    it('refuses the same name twice in a service', () => {
      const result = safeParseAppSpec(
        pair({ app: ['P', 'P'], db: [] }),
      );
      assert.equal(result.success, false);
      assert.match(
        result.success ? '' : result.error.issues.map((i) => i.message).join(' '),
        /noms de secrets dupliqués/,
      );
    });

    it('refuses an alias whose name is already in env', () => {
      const result = safeParseAppSpec({
        name: 'boutique',
        version: '1.0.0',
        services: [
          {
            name: 'web',
            source: { type: 'image', ref: 'x' },
            port: 80,
            exposed: true,
            env: { P: 'x' },
            secrets: [{ name: 'P', from: 'Q' }, 'Q'],
          },
        ],
      });
      assert.equal(result.success, false);
    });

    it('completeSecretValues gives the same value to both names', () => {
      const spec = parseAppSpec(
        pair({
          app: [{ name: 'WORDPRESS_DB_PASSWORD', from: 'MARIADB_PASSWORD' }],
          db: ['MARIADB_PASSWORD'],
        }),
      );
      const values = completeSecretValues(spec, { MARIADB_PASSWORD: 's3cr3t' });
      assert.deepEqual(values, {
        WORDPRESS_DB_PASSWORD: 's3cr3t',
        MARIADB_PASSWORD: 's3cr3t',
      });
    });

    it('names the root, not the alias, when the value is missing', () => {
      const spec = parseAppSpec(
        pair({
          app: [{ name: 'WORDPRESS_DB_PASSWORD', from: 'MARIADB_PASSWORD' }],
          db: ['MARIADB_PASSWORD'],
        }),
      );
      assert.throws(
        () => completeSecretValues(spec, {}),
        (error: Error) =>
          error.message.includes('MARIADB_PASSWORD') &&
          !error.message.includes('WORDPRESS_DB_PASSWORD'),
      );
    });
  });

  describe('runtime neutrality', () => {
    it('no schema field names a runtime', () => {
      const source = readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'spec', 'app-spec.ts'),
        'utf8',
      );
      // We inspect the declared keys, not the comments.
      const declaredKeys = [...source.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s/gm)].map(
        (match) => match[1] ?? '',
      );
      const forbidden = /compose|kubernetes|k8s|k3s|imagepullpolicy|restartpolicy|namespace/i;
      const offenders = declaredKeys.filter((key) => forbidden.test(key));
      assert.deepEqual(offenders, [], `runtime-specific fields: ${offenders.join(', ')}`);
    });
  });
});
