import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLocalHostname, registrableDomainOf } from '../src/domain-inspection.js';

describe('domain reading', () => {
  it('finds a name’s registered domain', () => {
    assert.equal(registrableDomainOf('app.exemple.fr'), 'exemple.fr');
    assert.equal(registrableDomainOf('exemple.fr'), 'exemple.fr');
    assert.equal(registrableDomainOf('a.b.exemple.co.uk'), 'exemple.co.uk');
    assert.equal(registrableDomainOf('www.mairie.gouv.fr'), 'mairie.gouv.fr');
    assert.equal(registrableDomainOf('Blog.Exemple.COM.'), 'exemple.com');
    assert.equal(registrableDomainOf('localhost'), null);
    assert.equal(registrableDomainOf('co.uk'), null);
  });

  it('recognizes the names no registry knows', () => {
    for (const name of ['localhost', 'bonjour.localhost', 'app.test', 'nas.home.arpa', 'srv.lan']) {
      assert.equal(isLocalHostname(name), true, name);
    }
    for (const name of ['exemple.fr', 'testing.fr', 'local-shop.com', 'app.nip.io']) {
      assert.equal(isLocalHostname(name), false, name);
    }
  });
});
