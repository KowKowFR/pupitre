import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SSO_SETTINGS, ssoSettingsSchema } from '../src/settings.js';
import {
  claimValues,
  roleFromGroups,
  ssoCallbackUrl,
  ssoDiscoveryUrl,
  ssoScopes,
} from '../src/sso.js';

describe('single sign-on — what is read from the profile', () => {
  it('reads a field by its path, string or list', () => {
    const profile = { groups: ['/ops', 'dev', 3], realm_access: { roles: ['admin'] }, team: 'sre' };
    assert.deepEqual(claimValues(profile, 'groups'), ['/ops', 'dev']);
    assert.deepEqual(claimValues(profile, 'realm_access.roles'), ['admin']);
    assert.deepEqual(claimValues(profile, 'team'), ['sre']);
    assert.deepEqual(claimValues(profile, 'absent.chemin'), []);
    assert.deepEqual(claimValues(null, 'groups'), []);
  });

  it('the first match wins, full path or not', () => {
    const settings = {
      roleMappings: [
        { group: 'admins', role: 'admin' },
        { group: '/ops', role: 'operator' },
      ],
      defaultRole: 'no-access',
    };
    assert.deepEqual(roleFromGroups(['/ops', '/admins'], settings), {
      role: 'admin',
      matched: 'admins',
    });
    assert.deepEqual(roleFromGroups(['ops'], settings), { role: 'operator', matched: '/ops' });
    assert.deepEqual(roleFromGroups(['dev'], settings), { role: 'no-access', matched: null });
    assert.deepEqual(roleFromGroups([], settings), { role: 'no-access', matched: null });
  });

  it('openid always first, without duplicates', () => {
    assert.deepEqual(ssoScopes('profile email openid email'), ['openid', 'profile', 'email']);
    assert.deepEqual(ssoScopes(''), ['openid']);
  });

  it('the addresses to declare and to read', () => {
    assert.equal(
      ssoCallbackUrl('https://pupitre.exemple.fr/'),
      'https://pupitre.exemple.fr/api/auth/callback/oidc',
    );
    assert.equal(
      ssoDiscoveryUrl('https://auth.exemple.fr/realms/pupitre/'),
      'https://auth.exemple.fr/realms/pupitre/.well-known/openid-configuration',
    );
  });

  it('disabled by default, a newcomer without access', () => {
    assert.equal(DEFAULT_SSO_SETTINGS.enabled, false);
    assert.equal(DEFAULT_SSO_SETTINGS.defaultRole, 'no-access');
    assert.equal(ssoSettingsSchema.safeParse({ issuer: 'ftp://x' }).success, false);
    assert.equal(ssoSettingsSchema.safeParse({ groupsClaim: 'groups; drop' }).success, false);
  });
});
