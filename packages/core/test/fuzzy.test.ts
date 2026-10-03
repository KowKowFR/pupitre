import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { editDistance, foldText, matchScore, queryTokens, rankByMatch } from '../src/fuzzy.js';

describe('correspondance tolérante', () => {
  it('ignore accents et casse', () => {
    assert.equal(foldText('Déploiement'), 'deploiement');
    assert.ok(matchScore('deploiement', ['Déploiement de blog']) > 0);
    assert.ok(matchScore('PROD', ['prod-1']) > 0);
  });

  it('exige que chaque mot réponde', () => {
    assert.ok(matchScore('api prod', ['api-facturation', 'prod-1']) > 0);
    assert.equal(matchScore('api zzz', ['api-facturation', 'prod-1']), 0);
  });

  it('accepte les lettres dans l’ordre et les fautes de frappe', () => {
    assert.ok(matchScore('prd1', ['prod-1']) > 0, 'lettres dans l’ordre');
    assert.ok(matchScore('umamo', ['umami']) > 0, 'une lettre fausse');
    assert.ok(matchScore('grafnaa', ['grafana']) > 0, 'deux lettres inversées puis une en trop');
    assert.ok(matchScore('portail-cleint', ['portail-client']) > 0, 'inversion');
    assert.equal(matchScore('zx', ['prod-1']), 0, 'deux lettres sans rapport');
    assert.equal(matchScore('blug', ['grafana']), 0);
  });

  it('ne trouve pas n’importe quoi dans une description', () => {
    const summary = 'Interface web pour discuter avec des modèles de langage, open source';
    assert.equal(matchScore('umamo', ['Open WebUI', 'open-webui'], [summary]), 0);
    assert.ok(
      matchScore('discuter', ['Open WebUI'], [summary]) > 0,
      'un mot exact de la description',
    );
    assert.equal(
      matchScore('discutre', ['Open WebUI'], [summary]),
      0,
      'pas de faute de frappe en prose',
    );
  });

  it('range le nom exact devant la faute de frappe', () => {
    const ranked = rankByMatch('blog', ['blob', 'blog', 'backlog-old'], (name) => [name]);
    assert.equal(ranked[0], 'blog');
  });

  it('lit un numéro de run', () => {
    assert.deepEqual(queryTokens('#127  Blog '), ['127', 'blog']);
  });

  it('borne la distance d’édition', () => {
    assert.equal(editDistance('umami', 'umamo', 1), 1);
    assert.equal(editDistance('ab', 'ba', 1), 1);
    assert.equal(editDistance('abcdef', 'uvwxyz', 1), 2);
  });
});
