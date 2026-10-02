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

describe('second facteur exigé', () => {
  it('les permissions sensibles existent, et aucune n’est une lecture', () => {
    for (const permission of SENSITIVE_PERMISSIONS) {
      assert.ok(isPermission(permission), permission);
      assert.ok(!permission.endsWith(':read'), permission);
    }
  });

  it('« sensibles » y soumet l’administrateur et l’opérateur, pas qui ne fait que lire', () => {
    const required = (role: keyof typeof ROLE_DEFINITIONS) =>
      requiresTwoFactor(ROLE_DEFINITIONS[role].permissions, 'sensitive');
    assert.equal(required('admin'), true);
    assert.equal(required('operator'), true);
    assert.equal(required('auditor'), false);
    assert.equal(required('viewer'), false);
    assert.equal(required('no-access'), false);
  });

  it('un rôle sur mesure qui ne fait que déployer y est soumis : déployer, c’est exécuter', () => {
    assert.equal(requiresTwoFactor(['deployment:read', 'deployment:create'], 'sensitive'), true);
    assert.equal(requiresTwoFactor(['deployment:read', 'deployment:rollback'], 'sensitive'), false);
  });

  it('« tous » et « personne » ne regardent pas les permissions', () => {
    assert.equal(requiresTwoFactor([], 'all'), true);
    assert.equal(requiresTwoFactor([...PERMISSIONS], 'off'), false);
  });
});
