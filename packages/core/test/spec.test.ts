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
  topologicalOrder,
} from '../src/spec/index.js';

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
    it('simple.json est accepté et reçoit ses defaults', () => {
      const spec = parseAppSpec(loadFixture('simple'));
      assert.equal(spec.name, 'demo-api');
      assert.equal(spec.services.length, 1);

      const [service] = spec.services;
      assert.ok(service);
      assert.equal(service.replicas, 1, 'replicas défaut à 1');
      assert.deepEqual(service.secrets, []);
      assert.deepEqual(service.volumes, []);
      assert.deepEqual(service.dependsOn, []);
      assert.equal(service.resources.cpuMilli, 500);
    });

    it('fullstack.json est accepté avec volumes, secrets et dependsOn', () => {
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

    it('ordonne les services par dépendance', () => {
      const spec = parseAppSpec(loadFixture('fullstack'));
      const order = topologicalOrder(spec).map((s) => s.name);
      assert.ok(
        order.indexOf('postgres') < order.indexOf('api'),
        `postgres doit précéder api : ${order.join(' → ')}`,
      );
      assert.ok(order.indexOf('api') < order.indexOf('front'));
    });
  });

  describe('invalid.json est rejeté', () => {
    const result = safeParseAppSpec(loadFixture('invalid'));

    it('échoue globalement', () => {
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
          `aucun message ne correspond à ${pattern}\nmessages : ${messages.join(' | ')}`,
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

    it('exige au moins un service', () => {
      assert.equal(safeParseAppSpec({ ...base, services: [] }).success, false);
    });

    it('exige exactement un service exposed — zéro échoue', () => {
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

    it('exige exactement un service exposed — deux échouent', () => {
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

    it('refuse un service qui dépend de lui-même', () => {
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

    it('détecte un cycle indirect front → api → cache → front', () => {
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

    it('accepte un graphe en losange, qui n’est pas un cycle', () => {
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

    it('refuse une clé déclarée à la fois en env et en secret', () => {
      const result = safeParseAppSpec({
        ...base,
        services: [{ ...base.services[0], env: { TOKEN: 'x' }, secrets: ['TOKEN'] }],
      });
      assert.equal(result.success, false);
    });

    it('findDependencyCycle retourne le cycle trouvé', () => {
      const cycle = findDependencyCycle([
        { name: 'api', dependsOn: ['cache'] },
        { name: 'cache', dependsOn: ['api'] },
      ]);
      assert.deepEqual(cycle, ['api', 'cache', 'api']);
    });
  });

  describe('neutralité vis-à-vis du runtime', () => {
    it('aucun champ du schéma ne nomme un runtime', () => {
      const source = readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'spec', 'app-spec.ts'),
        'utf8',
      );
      // On inspecte les clés déclarées, pas les commentaires.
      const declaredKeys = [...source.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s/gm)].map(
        (match) => match[1] ?? '',
      );
      const forbidden = /compose|kubernetes|k8s|k3s|imagepullpolicy|restartpolicy|namespace/i;
      const offenders = declaredKeys.filter((key) => forbidden.test(key));
      assert.deepEqual(offenders, [], `champs spécifiques à un runtime : ${offenders.join(', ')}`);
    });
  });
});
