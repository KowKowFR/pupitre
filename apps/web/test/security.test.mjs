import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

/**
 * Une écriture d'un navigateur doit venir du panel lui-même : c'est ce qui
 * empêche une page d'un sous-domaine voisin — une application que Pupitre a
 * peut-être déployée — de faire agir un administrateur connecté à son insu.
 */

const { foreignWrite, originOf } = await import('../src/lib/same-origin.ts');

const PANEL = 'https://pupitre.exemple.fr';
const request = (method, headers = {}) => ({ method, headers: new Headers(headers) });

describe('écritures venues d’ailleurs que le panel', () => {
  it('laisse passer une lecture, d’où qu’elle vienne', () => {
    assert.equal(foreignWrite(request('GET', { origin: 'https://blog.exemple.fr' }), PANEL), null);
    assert.equal(foreignWrite(request('HEAD'), PANEL), null);
  });

  it('laisse passer une écriture du panel', () => {
    assert.equal(foreignWrite(request('POST', { origin: PANEL }), PANEL), null);
    assert.equal(foreignWrite(request('DELETE', { 'sec-fetch-site': 'same-origin' }), PANEL), null);
  });

  it('refuse une écriture d’un sous-domaine voisin, même « same-site »', () => {
    assert.match(
      foreignWrite(
        request('POST', { origin: 'https://blog.exemple.fr', 'sec-fetch-site': 'same-site' }),
        PANEL,
      ) ?? '',
      /blog\.exemple\.fr/,
    );
    assert.match(
      foreignWrite(request('PUT', { 'sec-fetch-site': 'same-site' }), PANEL) ?? '',
      /same-site/,
    );
    assert.match(
      foreignWrite(request('PATCH', { 'sec-fetch-site': 'cross-site' }), PANEL) ?? '',
      /cross-site/,
    );
  });

  it('refuse une origine « null » et un autre port ou schéma', () => {
    assert.ok(foreignWrite(request('POST', { origin: 'null' }), PANEL));
    assert.ok(foreignWrite(request('POST', { origin: 'http://pupitre.exemple.fr' }), PANEL));
    assert.ok(foreignWrite(request('POST', { origin: 'https://pupitre.exemple.fr:8443' }), PANEL));
  });

  it('laisse passer un client qui n’est pas un navigateur — ni Origin, ni Sec-Fetch-Site', () => {
    assert.equal(
      foreignWrite(request('POST', { 'content-type': 'application/json' }), PANEL),
      null,
    );
  });

  it('tire l’origine de BETTER_AUTH_URL, chemin et barre finale compris', () => {
    assert.equal(originOf('https://pupitre.exemple.fr/'), PANEL);
    assert.equal(originOf('http://localhost:3000/panel'), 'http://localhost:3000');
  });
});
