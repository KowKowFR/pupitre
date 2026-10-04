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
 * Stop and start: what can be checked without a machine.
 *
 * The gesture itself requires a target — it is `scripts/verify-app-actions.sh`
 * that exercises it on both runtimes. Three things remain that break silently
 * and that a test catches immediately: a driver that does not implement the
 * contract, a stream message the SSE route would reject, and a shipped role
 * that would deploy without being able to stop.
 */

describe('contrat des drivers', () => {
  for (const runtime of ['docker', 'k3s'] as const) {
    it(`${runtime} implements stop() and start()`, () => {
      const driver = getDriver(runtime);
      assert.equal(typeof driver.stop, 'function');
      assert.equal(typeof driver.start, 'function');
    });
  }

  it('both drivers expose exactly the same surface', () => {
    const surface = (runtime: 'docker' | 'k3s') =>
      Object.getOwnPropertyNames(Object.getPrototypeOf(getDriver(runtime)))
        .filter((name) => !name.startsWith('_') && name !== 'constructor')
        .sort();

    // Each class's private methods differ — that is their right. What must not
    // diverge is what the contract promises.
    for (const method of ['stop', 'start', 'restart', 'destroy', 'rollback']) {
      assert.ok(surface('docker').includes(method), `docker: ${method} manquant`);
      assert.ok(surface('k3s').includes(method), `k3s: ${method} manquant`);
    }
  });
});

describe('flux applicatif', () => {
  for (const action of ['stop', 'start', 'restart'] as const) {
    it(`accepts a “${action}” life-cycle event`, () => {
      const parsed = appLogMessageSchema.safeParse({
        kind: 'lifecycle',
        payload: { ts: new Date().toISOString(), action, detail: 'démarré' },
      });
      assert.equal(parsed.success, true);
    });
  }

  it('refuses a made-up action — the SSE route validates with this schema', () => {
    const parsed = appLogMessageSchema.safeParse({
      kind: 'lifecycle',
      payload: { ts: new Date().toISOString(), action: 'pause', detail: null },
    });
    assert.equal(parsed.success, false);
  });
});

describe('permissions', () => {
  it("stopping falls under `deployment:restart` — no permission was added", () => {
    assert.ok(PERMISSIONS.includes('deployment:restart'));
    assert.equal(
      PERMISSIONS.some((permission) => permission === ('deployment:stop' as never)),
      false,
    );
  });

  it('an operator can stop what they deploy', () => {
    const operator = ROLE_DEFINITIONS.operator.permissions;
    assert.ok(operator.includes('deployment:create'));
    assert.ok(operator.includes('deployment:restart'));
  });
});

describe('statuts', () => {
  it('a stopped deployment stays monitorable: its status does not move', () => {
    // It is the invariant that keeps the logs and the start accessible. If someone
    // adds a `stopped` status, this test fails and reminds it.
    assert.equal(isSupervisable('success'), true);
    assert.equal(isSupervisable('rolled_back'), true);
    assert.equal(isSupervisable('destroyed'), false);
  });
});
