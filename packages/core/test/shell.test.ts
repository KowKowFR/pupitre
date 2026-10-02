import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { firstLine, shellQuote } from '../src/shell.js';

/**
 * `shellQuote` protège chaque valeur qui entre dans une commande distante.
 * L'épreuve : un vrai `sh` doit rendre la valeur telle quelle, sans rien en
 * exécuter.
 */

const TRAPS = [
  'simple',
  "l'apostrophe",
  "'' deux apostrophes ''",
  '$(touch /tmp/pupitre-piege)',
  '`id`',
  '${HOME}',
  'a; rm -rf /',
  'a && b || c | d > e < f',
  'ligne\nsuivante',
  'tab\tulation',
  '',
  '-n',
  '*',
  '\\',
];

describe('shellQuote', () => {
  it('un vrai sh rend chaque valeur piégée à l’identique', () => {
    for (const value of TRAPS) {
      const echoed = execFileSync('sh', ['-c', `printf '%s' ${shellQuote(value)}`]).toString();
      assert.equal(echoed, value, JSON.stringify(value));
    }
  });

  it('enferme tout entre apostrophes', () => {
    assert.equal(shellQuote('a b'), "'a b'");
    assert.equal(shellQuote("it's"), `'it'\\''s'`);
  });
});

describe('firstLine', () => {
  it('rend la première ligne non vide, sans ses espaces', () => {
    assert.equal(firstLine('\n\n  erreur : disque plein  \nsuite'), 'erreur : disque plein');
    assert.equal(firstLine('   \n\t\n'), null);
    assert.equal(firstLine(''), null);
  });
});
