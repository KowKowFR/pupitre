import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Les jetons d'API : leur forme, leur lecture dans l'en-tête, et la règle qui
 * empêche un jeton limité à une application d'agir sur les autres.
 */

const { API_TOKEN_PREFIX, bearerToken, generateApiToken, hashApiToken } =
  await import('../src/lib/api-token-format.ts');

const headers = (value) => new Headers(value === undefined ? {} : { authorization: value });

describe('jetons d’API — la forme', () => {
  it('pup_, 32 octets d’aléa, un préfixe affichable, une empreinte stable', () => {
    const { token, prefix, hash } = generateApiToken();
    assert.match(token, /^pup_[A-Za-z0-9_-]{43}$/);
    assert.equal(prefix, token.slice(0, 12));
    assert.ok(prefix.startsWith(API_TOKEN_PREFIX));
    assert.equal(hash, hashApiToken(token));
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.notEqual(generateApiToken().token, token);
  });

  it('lit un Bearer, ignore les autres schémas, refuse ce qui n’en a pas la forme', () => {
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
 * Les routes qui acceptent un jeton limité à des applications. Chacune est
 * une décision : l'ajouter ici, c'est avoir vérifié qu'elle contrôle
 * l'application visée **avant** d'agir.
 */
const SCOPED = [
  'applications/[id]/redeploy/route.ts',
  'applications/[id]/route.ts',
  'deployments/[id]/logs/route.ts',
  'deployments/[id]/rollback/route.ts',
  'deployments/[id]/route.ts',
  'deployments/route.ts',
];

describe('jetons d’API — la portée par application', () => {
  const files = routes(API);

  it('seules les routes retenues acceptent un jeton limité', () => {
    const scoped = files
      .filter((file) => readFileSync(file, 'utf8').includes('applicationScoped: true'))
      .map((file) => path.relative(API, file).split(path.sep).join('/'))
      .sort();
    assert.deepEqual(scoped, [...SCOPED].sort());
  });

  it('chacune vérifie l’application visée', () => {
    for (const relative of SCOPED) {
      const source = readFileSync(path.join(API, relative), 'utf8');
      const declared = (source.match(/applicationScoped: true/g) ?? []).length;
      const checked = (source.match(/requireApplicationScope\(request, auth,/g) ?? []).length;
      assert.ok(
        checked >= declared,
        `${relative} : ${declared} déclaration(s), ${checked} vérification(s)`,
      );
    }
  });

  it('la gestion des jetons se fait depuis le panel, jamais avec un jeton', () => {
    for (const relative of ['tokens/route.ts', 'tokens/[id]/route.ts']) {
      const source = readFileSync(path.join(API, relative), 'utf8');
      assert.ok(source.includes('requireTeamMember(request)'), relative);
    }
    const admin = readFileSync(path.join(API, 'admin/tokens/route.ts'), 'utf8');
    assert.ok(admin.includes('sessionOnly: true'));
  });
});
