import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PERMISSIONS,
  ROLE_DEFINITIONS,
  SEEDED_ROLES,
  SIGNUP_ROLE,
  isPermission,
} from '../src/permissions.js';

/**
 * Les rôles de départ. Ce ne sont que des valeurs posées sur une base vierge,
 * mais ce sont celles que presque tout le monde garde : ce qu'elles ouvrent se
 * vérifie ici, permission par permission.
 */

const READS = PERMISSIONS.filter((permission) => permission.endsWith(':read'));
const ADMINISTRATION = ['user:read', 'role:read', 'audit:read', 'settings:read'] as const;

describe('rôles de départ', () => {
  it('chaque rôle de départ a sa définition, et ne porte que des permissions connues', () => {
    for (const key of SEEDED_ROLES) {
      const definition = ROLE_DEFINITIONS[key];
      assert.ok(definition, key);
      for (const permission of definition.permissions) {
        assert.ok(isPermission(permission), `${key} : ${permission}`);
      }
    }
  });

  it("l'auditeur lit tout, et n'écrit rien", () => {
    assert.deepEqual([...ROLE_DEFINITIONS.auditor.permissions].sort(), [...READS].sort());
  });

  it("l'observateur lit l'exploitation, pas l'administration", () => {
    const viewer = ROLE_DEFINITIONS.viewer.permissions;
    for (const permission of ADMINISTRATION) {
      assert.ok(!viewer.includes(permission), `l'observateur porte ${permission}`);
    }
    for (const permission of viewer) {
      assert.ok(permission.endsWith(':read'), `l'observateur écrit : ${permission}`);
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

  it("une inscription publique n'ouvre rien", () => {
    assert.equal(SIGNUP_ROLE, 'no-access');
    assert.deepEqual(ROLE_DEFINITIONS[SIGNUP_ROLE].permissions, []);
  });
});
