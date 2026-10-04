import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { editDistance, foldText, matchScore, queryTokens, rankByMatch } from '../src/fuzzy.js';

describe('tolerant matching', () => {
  it('ignore accents et casse', () => {
    assert.equal(foldText('Déploiement'), 'deploiement');
    assert.ok(matchScore('deploiement', ['Déploiement de blog']) > 0);
    assert.ok(matchScore('PROD', ['prod-1']) > 0);
  });

  it('requires each word to match', () => {
    assert.ok(matchScore('api prod', ['api-facturation', 'prod-1']) > 0);
    assert.equal(matchScore('api zzz', ['api-facturation', 'prod-1']), 0);
  });

  it('accepts letters in order and typos', () => {
    assert.ok(matchScore('prd1', ['prod-1']) > 0, 'lettres dans l’ordre');
    assert.ok(matchScore('umamo', ['umami']) > 0, 'une lettre fausse');
    assert.ok(matchScore('grafnaa', ['grafana']) > 0, 'two swapped letters then an extra one');
    assert.ok(matchScore('portail-cleint', ['portail-client']) > 0, 'inversion');
    assert.equal(matchScore('zx', ['prod-1']), 0, 'deux lettres sans rapport');
    assert.equal(matchScore('blug', ['grafana']), 0);
  });

  it('does not find just anything in a description', () => {
    const summary = 'Interface web pour discuter avec des modèles de langage, open source';
    assert.equal(matchScore('umamo', ['Open WebUI', 'open-webui'], [summary]), 0);
    assert.ok(
      matchScore('discuter', ['Open WebUI'], [summary]) > 0,
      'an exact word of the description',
    );
    assert.equal(
      matchScore('discutre', ['Open WebUI'], [summary]),
      0,
      'pas de faute de frappe en prose',
    );
  });

  it('ranks the exact name before the typo', () => {
    const ranked = rankByMatch('blog', ['blob', 'blog', 'backlog-old'], (name) => [name]);
    assert.equal(ranked[0], 'blog');
  });

  it('reads a run number', () => {
    assert.deepEqual(queryTokens('#127  Blog '), ['127', 'blog']);
  });

  it('bounds the edit distance', () => {
    assert.equal(editDistance('umami', 'umamo', 1), 1);
    assert.equal(editDistance('ab', 'ba', 1), 1);
    assert.equal(editDistance('abcdef', 'uvwxyz', 1), 2);
  });
});
