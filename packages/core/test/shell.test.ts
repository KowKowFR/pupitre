import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { firstLine, shellQuote } from '../src/shell.js';

/**
 * `shellQuote` protects each value that goes into a remote command. The test: a
 * real `sh` must return the value as is, without running any of it.
 */

const TRAPS = [
  'simple',
  "l'apostrophe",
  "'' deux apostrophes ''",
  '$(touch /tmp/pupitre-trap)',
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
  it('a real sh returns each booby-trapped value identically', () => {
    for (const value of TRAPS) {
      const echoed = execFileSync('sh', ['-c', `printf '%s' ${shellQuote(value)}`]).toString();
      assert.equal(echoed, value, JSON.stringify(value));
    }
  });

  it('wraps everything in single quotes', () => {
    assert.equal(shellQuote('a b'), "'a b'");
    assert.equal(shellQuote("it's"), `'it'\\''s'`);
  });
});

describe('firstLine', () => {
  it('returns the first non-empty line, trimmed', () => {
    assert.equal(firstLine('\n\n  erreur : disque plein  \nsuite'), 'erreur : disque plein');
    assert.equal(firstLine('   \n\t\n'), null);
    assert.equal(firstLine(''), null);
  });
});
