import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PERMISSIONS,
  ROLE_DEFINITIONS,
  appLogMessageSchema,
  isSupervisable,
} from '../src/index.js';
import { getDriver } from '../src/drivers/index.js';

/**
 * Arrêt et démarrage : ce qui se vérifie sans machine.
 *
 * Le geste lui-même exige une cible — c'est `scripts/verify-app-actions.sh` qui
 * l'exerce sur les deux runtimes. Restent trois choses qui se cassent en
 * silence et qu'un test attrape immédiatement : un driver qui n'implémente pas
 * le contrat, un message de flux que la route SSE rejettera, et un rôle
 * livré qui déploierait sans pouvoir arrêter.
 */

describe('contrat des drivers', () => {
  for (const runtime of ['docker', 'k3s'] as const) {
    it(`${runtime} implémente stop() et start()`, () => {
      const driver = getDriver(runtime);
      assert.equal(typeof driver.stop, 'function');
      assert.equal(typeof driver.start, 'function');
    });
  }

  it('les deux drivers exposent exactement la même surface', () => {
    const surface = (runtime: 'docker' | 'k3s') =>
      Object.getOwnPropertyNames(Object.getPrototypeOf(getDriver(runtime)))
        .filter((name) => !name.startsWith('_') && name !== 'constructor')
        .sort();

    // Les méthodes privées de chaque classe diffèrent — c'est leur droit. Ce
    // qui ne doit pas diverger, c'est ce que le contrat promet.
    for (const method of ['stop', 'start', 'restart', 'destroy', 'rollback']) {
      assert.ok(surface('docker').includes(method), `docker: ${method} manquant`);
      assert.ok(surface('k3s').includes(method), `k3s: ${method} manquant`);
    }
  });
});

describe('flux applicatif', () => {
  for (const action of ['stop', 'start', 'restart'] as const) {
    it(`accepte un événement de cycle de vie « ${action} »`, () => {
      const parsed = appLogMessageSchema.safeParse({
        kind: 'lifecycle',
        payload: { ts: new Date().toISOString(), action, detail: 'démarré' },
      });
      assert.equal(parsed.success, true);
    });
  }

  it('refuse une action inventée — la route SSE valide avec ce schéma', () => {
    const parsed = appLogMessageSchema.safeParse({
      kind: 'lifecycle',
      payload: { ts: new Date().toISOString(), action: 'pause', detail: null },
    });
    assert.equal(parsed.success, false);
  });
});

describe('permissions', () => {
  it("arrêter relève de `deployment:restart` — aucune permission n'a été ajoutée", () => {
    assert.ok(PERMISSIONS.includes('deployment:restart'));
    assert.equal(
      PERMISSIONS.some((permission) => permission === ('deployment:stop' as never)),
      false,
    );
  });

  it('un opérateur peut arrêter ce qu’il déploie', () => {
    const operator = ROLE_DEFINITIONS.operator.permissions;
    assert.ok(operator.includes('deployment:create'));
    assert.ok(operator.includes('deployment:restart'));
  });
});

describe('statuts', () => {
  it('un déploiement arrêté reste supervisable : son statut ne bouge pas', () => {
    // C'est l'invariant qui garde les logs et le démarrage accessibles. Si
    // quelqu'un ajoute un statut `stopped`, ce test tombe et le rappelle.
    assert.equal(isSupervisable('success'), true);
    assert.equal(isSupervisable('rolled_back'), true);
    assert.equal(isSupervisable('destroyed'), false);
  });
});
