import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PERMISSIONS,
  ROLE_DEFINITIONS,
  SEEDED_ROLES,
  SENSITIVE_PERMISSIONS,
  SIGNUP_ROLE,
  isPermission,
  requiresTwoFactor,
} from '../src/permissions.js';

/**
 * The starting roles. They are only values set on an empty database, but they
 * are the ones almost everybody keeps: what they open is checked here,
 * permission by permission.
 */

const READS = PERMISSIONS.filter((permission) => permission.endsWith(':read'));
const ADMINISTRATION = ['user:read', 'role:read', 'audit:read', 'settings:read'] as const;

describe('starting roles', () => {
  it('each starting role has its definition, and only carries known permissions', () => {
    for (const key of SEEDED_ROLES) {
      const definition = ROLE_DEFINITIONS[key];
      assert.ok(definition, key);
      for (const permission of definition.permissions) {
        assert.ok(isPermission(permission), `${key} : ${permission}`);
      }
    }
  });

  it("the auditor reads everything, and writes nothing", () => {
    assert.deepEqual([...ROLE_DEFINITIONS.auditor.permissions].sort(), [...READS].sort());
  });

  it("l'observateur lit l'exploitation, pas l'administration", () => {
    const viewer = ROLE_DEFINITIONS.viewer.permissions;
    for (const permission of ADMINISTRATION) {
      assert.ok(!viewer.includes(permission), `l'observateur porte ${permission}`);
    }
    for (const permission of viewer) {
      assert.ok(permission.endsWith(':read'), `the viewer writes: ${permission}`);
    }
    for (const permission of [
      'target:read',
      'application:read',
      'deployment:read',
      'monitor:read',
      'scan:read',
    ] as const) {
      assert.ok(viewer.includes(permission), `l'observateur ne lit pas ${permission}`);
    }
  });

  it("a public sign-up opens nothing", () => {
    assert.equal(SIGNUP_ROLE, 'no-access');
    assert.deepEqual(ROLE_DEFINITIONS[SIGNUP_ROLE].permissions, []);
  });
});

describe('second factor required', () => {
  it('the sensitive permissions exist, and none is a read', () => {
    for (const permission of SENSITIVE_PERMISSIONS) {
      assert.ok(isPermission(permission), permission);
      assert.ok(!permission.endsWith(':read'), permission);
    }
  });

  it('“sensitive” binds the administrator and the operator, not whoever only reads', () => {
    const required = (role: keyof typeof ROLE_DEFINITIONS) =>
      requiresTwoFactor(ROLE_DEFINITIONS[role].permissions, 'sensitive');
    assert.equal(required('admin'), true);
    assert.equal(required('operator'), true);
    assert.equal(required('auditor'), false);
    assert.equal(required('viewer'), false);
    assert.equal(required('no-access'), false);
  });

  it('a custom role that only deploys is bound: deploying is running code', () => {
    assert.equal(requiresTwoFactor(['deployment:read', 'deployment:create'], 'sensitive'), true);
    assert.equal(requiresTwoFactor(['deployment:read', 'deployment:rollback'], 'sensitive'), false);
  });

  it('“all” and “nobody” do not look at permissions', () => {
    assert.equal(requiresTwoFactor([], 'all'), true);
    assert.equal(requiresTwoFactor([...PERMISSIONS], 'off'), false);
  });
});
