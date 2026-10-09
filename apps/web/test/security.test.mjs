import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * A browser's write must come from the panel itself: that is what prevents a page
 * of a neighboring subdomain — an application Pupitre may have deployed — from
 * making a signed-in administrator act unknowingly.
 */

const { foreignWrite, originOf } = await import('../src/lib/same-origin.ts');

const PANEL = 'https://pupitre.exemple.fr';
const request = (method, headers = {}) => ({ method, headers: new Headers(headers) });

describe('writes coming from elsewhere than the panel', () => {
  it('lets a read through, wherever it comes from', () => {
    assert.equal(foreignWrite(request('GET', { origin: 'https://blog.exemple.fr' }), PANEL), null);
    assert.equal(foreignWrite(request('HEAD'), PANEL), null);
  });

  it('lets a write from the panel through', () => {
    assert.equal(foreignWrite(request('POST', { origin: PANEL }), PANEL), null);
    assert.equal(foreignWrite(request('DELETE', { 'sec-fetch-site': 'same-origin' }), PANEL), null);
  });

  it('refuses a write from a neighboring subdomain, even "same-site"', () => {
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

  it('refuses a "null" origin and another port or scheme', () => {
    assert.ok(foreignWrite(request('POST', { origin: 'null' }), PANEL));
    assert.ok(foreignWrite(request('POST', { origin: 'http://pupitre.exemple.fr' }), PANEL));
    assert.ok(foreignWrite(request('POST', { origin: 'https://pupitre.exemple.fr:8443' }), PANEL));
  });

  it('lets through a client that is not a browser — neither Origin nor Sec-Fetch-Site', () => {
    assert.equal(
      foreignWrite(request('POST', { 'content-type': 'application/json' }), PANEL),
      null,
    );
  });

  it('draws the origin from BETTER_AUTH_URL, path and trailing slash included', () => {
    assert.equal(originOf('https://pupitre.exemple.fr/'), PANEL);
    assert.equal(originOf('http://localhost:3000/panel'), 'http://localhost:3000');
  });
});

describe('public sign-up', () => {
  const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

  it('only creates the first account: no switch reopens it', () => {
    const auth = read('../src/lib/auth.ts');
    const gate = /export async function isSignupOpen\(\)[^{]*\{([^}]*)\}/.exec(auth)?.[1] ?? '';
    assert.match(gate, /countUsers\(\)\) === 0/);
    assert.doesNotMatch(gate, /getEnv|process\.env/);
    assert.doesNotMatch(read('../src/lib/env.ts'), /ALLOW_SIGNUP:\s/);
    assert.doesNotMatch(read('../../../.env.example'), /^ALLOW_SIGNUP=/m);
  });
});
