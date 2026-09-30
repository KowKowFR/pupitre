import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

/**
 * Ce que les exports et la liste des sessions promettent, vérifié sur les
 * modules purs qui le portent : les cellules CSV qu'un tableur ne doit pas
 * exécuter, l'URL que la liste et l'export partagent, le nom d'un appareil.
 */

const { csvCell, csvRow } = await import('../src/lib/csv.ts');
const { filterParams } = await import('../src/app/(app)/deployments/filters.ts');
const { describeUserAgent } = await import('../src/lib/user-agent.ts');
const { compactIp } = await import('../src/lib/ip.ts');

describe('CSV des exports', () => {
  it('neutralise ce qu’un tableur exécuterait comme une formule', () => {
    for (const value of ['=HYPERLINK("x")', '+1', '-2', '@SUM(A1)', '\tx', '\rx']) {
      assert.ok(csvCell(value).replace(/^"/, '').startsWith("'"), `non neutralisé : ${value}`);
    }
  });

  it('laisse les nombres négatifs tels quels : ce sont des données, pas du texte', () => {
    assert.equal(csvCell(-3), '-3');
  });

  it('cite les virgules, guillemets et retours à la ligne (RFC 4180)', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('dit "non"'), '"dit ""non"""');
    assert.equal(csvCell('ligne\nsuivante'), '"ligne\nsuivante"');
  });

  it('écrit une cellule vide pour null, et termine la ligne par CRLF', () => {
    assert.equal(csvRow([129, null, 'docs', undefined]), '129,,docs,\r\n');
  });
});

describe('filtres de la liste des runs', () => {
  it('traduit « bloqués par un scan » en blocked=scan, pas en statut', () => {
    assert.equal(filterParams('scan_blocked', '').toString(), 'blocked=scan');
  });

  it('garde statut et recherche ensemble, pour la liste comme pour l’export', () => {
    assert.equal(filterParams('failed', '#127').toString(), 'status=failed&q=%23127');
  });

  it('n’écrit rien sans filtre', () => {
    assert.equal(filterParams(null, '').toString(), '');
  });
});

describe('appareil d’une session', () => {
  it('nomme navigateur, version majeure et système', () => {
    assert.equal(
      describeUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
      ),
      'Firefox 131 · Linux',
    );
    assert.equal(
      describeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      ),
      'Safari 17 · iPhone',
    );
  });

  it('ne confond pas Edge avec Chrome, qu’il imite', () => {
    assert.equal(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
      ),
      'Edge 129 · Windows',
    );
  });

  it('montre le premier jeton d’un agent qui n’est pas un navigateur', () => {
    assert.equal(describeUserAgent('curl/8.4.0'), 'curl/8.4.0');
    assert.equal(describeUserAgent('   '), null);
    assert.equal(describeUserAgent(null), null);
  });
});

describe('adresse d’une session', () => {
  it('raccourcit une IPv6 écrite en entier', () => {
    assert.equal(compactIp('0000:0000:0000:0000:0000:0000:0000:0001'), '::1');
    assert.equal(compactIp('0000:0000:0000:0000:0000:0000:0000:0000'), '::');
    assert.equal(compactIp('2001:0db8:0000:0000:0000:ff00:0042:8329'), '2001:db8::ff00:42:8329');
  });

  it('laisse passer une IPv4, une IPv6 déjà courte, et rien', () => {
    assert.equal(compactIp('192.168.10.12'), '192.168.10.12');
    assert.equal(compactIp('fe80::1'), 'fe80::1');
    assert.equal(compactIp(null), null);
  });
});

const { expandDayRange, zonedDayStart } = await import('../src/lib/day-range.ts');

describe('jours du filtre du journal', () => {
  it('lit un jour dans le fuseau de l’instance, pas en UTC', () => {
    assert.equal(zonedDayStart('2026-09-30', 'Europe/Paris')?.toISOString(), '2026-09-29T22:00:00.000Z');
    assert.equal(zonedDayStart('2026-09-30', 'UTC')?.toISOString(), '2026-09-30T00:00:00.000Z');
  });

  it('tient compte du changement d’heure', () => {
    // Heure d'été le 29 mars 2026 à 2 h : minuit est encore en UTC+1.
    assert.equal(zonedDayStart('2026-03-29', 'Europe/Paris')?.toISOString(), '2026-03-28T23:00:00.000Z');
    assert.equal(zonedDayStart('2026-03-30', 'Europe/Paris')?.toISOString(), '2026-03-29T22:00:00.000Z');
  });

  it('fait couvrir à « Au » la journée entière', () => {
    const range = expandDayRange({ from: '2026-09-29', to: '2026-09-30', action: 'x' }, 'Europe/Paris');
    assert.equal(range.from, '2026-09-28T22:00:00.000Z');
    assert.equal(range.to, '2026-09-30T21:59:59.999Z');
    assert.equal(range.action, 'x');
  });

  it('laisse un instant ISO tel quel, et retombe sur UTC pour un fuseau inconnu', () => {
    const iso = '2026-09-30T08:30:00.000Z';
    assert.equal(expandDayRange({ to: iso }, 'Europe/Paris').to, iso);
    assert.equal(zonedDayStart('2026-09-30', 'Nulle/Part')?.toISOString(), '2026-09-30T00:00:00.000Z');
  });
});
