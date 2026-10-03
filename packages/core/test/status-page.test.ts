import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dayBars,
  overallStateOf,
  publicStateOf,
  statusPageInputSchema,
  updateStatusPageSchema,
  statusPageMonitorIds,
  statusPagePath,
  statusPageSlugSchema,
  uptimeOf,
} from '../src/index.js';

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';

describe('page de statut — la forme', () => {
  it('une adresse vide mène à /status, une adresse choisie à /status/<adresse>', () => {
    assert.equal(statusPagePath(''), '/status');
    assert.equal(statusPagePath('clients'), '/status/clients');
    for (const ok of ['', 'clients', 'atelier-nord', 'v2'])
      assert.ok(statusPageSlugSchema.safeParse(ok).success, ok);
    for (const bad of ['Clients', '-clients', 'clients-', 'a b', 'é', 'a/b']) {
      assert.ok(!statusPageSlugSchema.safeParse(bad).success, bad);
    }
  });

  it('valide les blocs et refuse deux blocs au même identifiant', () => {
    const page = {
      slug: 'clients',
      title: 'État des services',
      blocks: [
        { id: 'a', type: 'summary' },
        {
          id: 'b',
          type: 'services',
          title: 'Applications',
          items: [{ monitorId: M1, label: 'Facturation' }],
          history: true,
          uptime: true,
        },
        { id: 'c', type: 'incidents', days: 14 },
      ],
    };
    const parsed = statusPageInputSchema.parse(page);
    assert.equal(parsed.published, false);
    assert.equal(parsed.description, null);
    assert.ok(
      !statusPageInputSchema.safeParse({
        ...page,
        blocks: [page.blocks[0], { id: 'a', type: 'maintenance' }],
      }).success,
    );
    assert.ok(
      !statusPageInputSchema.safeParse({
        ...page,
        blocks: [{ id: 'x', type: 'incidents', days: 3 }],
      }).success,
    );
    assert.ok(
      !statusPageInputSchema.safeParse({
        ...page,
        blocks: [
          { id: 'x', type: 'services', title: null, items: [], history: true, uptime: true },
        ],
      }).success,
    );
  });

  it('liste les sondes de la page dans l’ordre, sans doublon', () => {
    assert.deepEqual(
      statusPageMonitorIds([
        {
          id: 'a',
          type: 'services',
          title: null,
          items: [
            { monitorId: M2, label: null },
            { monitorId: M1, label: null },
          ],
          history: false,
          uptime: false,
        },
        { id: 'b', type: 'text', text: 'bonjour' },
        {
          id: 'c',
          type: 'services',
          title: null,
          items: [{ monitorId: M1, label: 'encore' }],
          history: false,
          uptime: false,
        },
      ]),
      [M2, M1],
    );
  });
});

describe('page de statut — ce que lit un visiteur', () => {
  it('une maintenance l’emporte, une sonde suspendue est inconnue', () => {
    assert.equal(
      publicStateOf({ status: 'unreachable', enabled: true, inMaintenance: true }),
      'maintenance',
    );
    assert.equal(
      publicStateOf({ status: 'healthy', enabled: false, inMaintenance: false }),
      'unknown',
    );
    assert.equal(
      publicStateOf({ status: 'healthy', enabled: true, inMaintenance: false }),
      'operational',
    );
    assert.equal(
      publicStateOf({ status: 'unhealthy', enabled: true, inMaintenance: false }),
      'degraded',
    );
    assert.equal(
      publicStateOf({ status: 'unreachable', enabled: true, inMaintenance: false }),
      'down',
    );
  });

  it('l’état général : panne partielle, majeure, maintenance', () => {
    assert.equal(overallStateOf(['operational', 'operational']), 'operational');
    assert.equal(overallStateOf(['operational', 'operational', 'down']), 'partial_outage');
    assert.equal(overallStateOf(['operational', 'down']), 'partial_outage');
    assert.equal(overallStateOf(['down', 'down', 'operational']), 'major_outage');
    assert.equal(overallStateOf(['down']), 'major_outage');
    assert.equal(overallStateOf(['operational', 'degraded']), 'degraded');
    assert.equal(overallStateOf(['operational', 'maintenance']), 'maintenance');
    assert.equal(overallStateOf([]), 'unknown');
  });

  it('une barre par jour ; un jour sans mesure reste vide', () => {
    const bars = dayBars(
      [
        { day: '2026-10-01', total: 1000, healthy: 1000 },
        { day: '2026-10-02', total: 100, healthy: 97 },
        { day: '2026-10-03', total: 100, healthy: 50 },
      ],
      '2026-10-03',
      4,
    );
    assert.deepEqual(
      bars.map((bar) => `${bar.day}:${bar.state}`),
      ['2026-09-30:empty', '2026-10-01:operational', '2026-10-02:degraded', '2026-10-03:down'],
    );
    assert.equal(
      uptimeOf([
        { day: 'x', total: 200, healthy: 150 },
        { day: 'y', total: 200, healthy: 200 },
      ]),
      87.5,
    );
    assert.equal(uptimeOf([]), null);
  });
});

describe('page de statut — une modification', () => {
  it('ne remplit pas ce qu’elle ne dit pas : un titre ne dépublie rien', () => {
    assert.deepEqual(updateStatusPageSchema.parse({ title: 'Nouveau titre' }), {
      title: 'Nouveau titre',
    });
  });

  it('la création, elle, garde ses valeurs par défaut', () => {
    const page = statusPageInputSchema.parse({ slug: '', title: 'État' });
    assert.equal(page.published, false);
    assert.equal(page.description, null);
    assert.deepEqual(page.blocks, []);
  });
});
