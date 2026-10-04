import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * API tokens: their shape, reading them in the header, and the rule that prevents
 * a token limited to one application from acting on the others.
 */

const { API_TOKEN_PREFIX, bearerToken, generateApiToken, hashApiToken } =
  await import('../src/lib/api-token-format.ts');

const headers = (value) => new Headers(value === undefined ? {} : { authorization: value });

describe('API tokens — the shape', () => {
  it('pup_, 32 random bytes, a displayable prefix, a stable fingerprint', () => {
    const { token, prefix, hash } = generateApiToken();
    assert.match(token, /^pup_[A-Za-z0-9_-]{43}$/);
    assert.equal(prefix, token.slice(0, 12));
    assert.ok(prefix.startsWith(API_TOKEN_PREFIX));
    assert.equal(hash, hashApiToken(token));
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.notEqual(generateApiToken().token, token);
  });

  it('reads a Bearer, ignores the other schemes, refuses what does not have its shape', () => {
    const { token } = generateApiToken();
    assert.equal(bearerToken(headers(`Bearer ${token}`)), token);
    assert.equal(bearerToken(headers(`bearer   ${token}  `)), token);
    assert.equal(bearerToken(headers()), null);
    assert.equal(bearerToken(headers('Basic dXNlcjpwYXNz')), null);
    assert.equal(bearerToken(headers('Bearer')), 'malformed');
    assert.equal(bearerToken(headers('Bearer ghp_quelquechose')), 'malformed');
    assert.equal(bearerToken(headers(`Bearer ${token}x`)), 'malformed');
    assert.equal(bearerToken(headers(`Bearer ${token} ${token}`)), 'malformed');
  });
});

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/app/api');

function routes(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routes(full);
    return name === 'route.ts' ? [full] : [];
  });
}

/**
 * The routes that accept a token limited to applications. Each one is a decision:
 * adding it here is having checked that it controls the targeted application
 * **before** acting.
 */
const SCOPED = [
  // A CI without a linked repository uploads its application's code, then deploys.
  'applications/[id]/archives/[archiveId]/route.ts',
  'applications/[id]/archives/route.ts',
  'applications/[id]/redeploy/route.ts',
  'applications/[id]/route.ts',
  'deployments/[id]/logs/route.ts',
  'deployments/[id]/rollback/route.ts',
  'deployments/[id]/route.ts',
  'deployments/route.ts',
];

describe('API tokens — the per-application scope', () => {
  const files = routes(API);

  it('only the chosen routes accept a limited token', () => {
    const scoped = files
      .filter((file) => readFileSync(file, 'utf8').includes('applicationScoped: true'))
      .map((file) => path.relative(API, file).split(path.sep).join('/'))
      .sort();
    assert.deepEqual(scoped, [...SCOPED].sort());
  });

  it('each one checks the targeted application', () => {
    for (const relative of SCOPED) {
      const source = readFileSync(path.join(API, relative), 'utf8');
      const declared = (source.match(/applicationScoped: true/g) ?? []).length;
      const checked = (source.match(/requireApplicationScope\(request, auth,/g) ?? []).length;
      assert.ok(
        checked >= declared,
        `${relative}: ${declared} declaration(s), ${checked} check(s)`,
      );
    }
  });

  it('tokens are managed from the panel, never with a token', () => {
    for (const relative of ['tokens/route.ts', 'tokens/[id]/route.ts']) {
      const source = readFileSync(path.join(API, relative), 'utf8');
      assert.ok(source.includes('requireTeamMember(request)'), relative);
    }
    const admin = readFileSync(path.join(API, 'admin/tokens/route.ts'), 'utf8');
    assert.ok(admin.includes('sessionOnly: true'));
  });
});
