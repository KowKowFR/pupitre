import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  alertsToRelease,
  buildNotificationMessage,
  createMaintenanceSchema,
  fromWallClockInput,
  maintenancePhase,
  maintenanceRuleOf,
  notifiableEventFor,
  toWallClockInput,
} from '../src/index.js';

const T = (iso: string) => new Date(iso).getTime();

describe('maintenance — la fenêtre', () => {
  const window = { startsAt: '2026-10-03T20:00:00Z', endsAt: '2026-10-03T21:00:00Z' };

  it('à venir, en cours, terminée — début inclus, fin exclue', () => {
    assert.equal(maintenancePhase(window, T('2026-10-03T19:59:59Z')), 'upcoming');
    assert.equal(maintenancePhase(window, T('2026-10-03T20:00:00Z')), 'active');
    assert.equal(maintenancePhase(window, T('2026-10-03T20:59:59Z')), 'active');
    assert.equal(maintenancePhase(window, T('2026-10-03T21:00:00Z')), 'ended');
  });

  it('refuse une fin avant le début, une fenêtre de plus d’un mois, une fenêtre vide', () => {
    const base = { title: 'Mise à jour du noyau', ...window, targetIds: [crypto.randomUUID()] };
    assert.ok(createMaintenanceSchema.safeParse(base).success);
    const reversed = createMaintenanceSchema.safeParse({ ...base, endsAt: base.startsAt });
    assert.ok(!reversed.success && reversed.error.issues[0]?.path[0] === 'endsAt');
    const long = createMaintenanceSchema.safeParse({ ...base, endsAt: '2026-11-10T00:00:00Z' });
    assert.ok(!long.success);
    const empty = createMaintenanceSchema.safeParse({ ...base, targetIds: [] });
    assert.ok(!empty.success && empty.error.issues[0]?.path[0] === 'targetIds');
  });

  it('la saisie parle le fuseau de l’instance, heure d’été comprise', () => {
    assert.equal(
      fromWallClockInput('2026-10-03T22:00', 'Europe/Paris'),
      '2026-10-03T20:00:00.000Z',
    );
    assert.equal(
      fromWallClockInput('2026-12-03T22:00', 'Europe/Paris'),
      '2026-12-03T21:00:00.000Z',
    );
    assert.equal(toWallClockInput('2026-10-03T20:00:00Z', 'Europe/Paris'), '2026-10-03T22:00');
    assert.equal(fromWallClockInput('pas une date', 'Europe/Paris'), null);
  });
});

describe('maintenance — les alertes retenues', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 3, 20, minute));
  const held = (id: string, family: string, opens: boolean, minute: number) => ({
    id,
    family,
    opens,
    heldAt: at(minute),
  });

  it('une panne réparée pendant la fenêtre ne part pas ; une panne toujours là, si', () => {
    const released = alertsToRelease([
      held('a', 'monitor:api', true, 5),
      held('b', 'monitor:api', false, 12),
      held('c', 'reach:prod-1', true, 20),
      held('d', 'monitor:blog', true, 2),
      held('e', 'monitor:blog', false, 3),
      held('f', 'monitor:blog', true, 40),
    ]);
    assert.deepEqual(
      released.map((alert) => alert.id),
      ['c', 'f'],
    );
  });

  it('un rétablissement seul ne part pas', () => {
    assert.deepEqual(alertsToRelease([held('a', 'reach:prod-1', false, 5)]), []);
  });
});

describe('maintenance — le catalogue', () => {
  it('les alertes de supervision ont une règle ; la sécurité et les déploiements, jamais', () => {
    const down = maintenanceRuleOf('monitor.down');
    assert.deepEqual(down?.subject({ resourceId: 'm-1', after: {} }), {
      type: 'monitor',
      id: 'm-1',
    });
    assert.equal(down?.family({ resourceId: 'm-1', after: {} }), 'monitor:m-1');
    assert.equal(down?.opens, true);
    assert.equal(maintenanceRuleOf('monitor.recovered')?.opens, false);
    assert.equal(
      maintenanceRuleOf('target.threshold.breached')?.family({
        resourceId: 't-1',
        after: { metric: 'disk' },
      }),
      'threshold:t-1:disk',
    );
    const route = maintenanceRuleOf('route.down');
    assert.deepEqual(route?.subject({ resourceId: 'app', after: { routeId: 'r-1' } }), {
      type: 'route',
      id: 'r-1',
    });
    // Une entrée écrite avant que la route y figure : jamais retenue.
    assert.equal(route?.subject({ resourceId: 'app', after: {} }), null);
    for (const key of [
      'security.host_key_changed',
      'deployment.failed',
      'backup.failed',
      'forecast.raised',
    ] as const) {
      assert.equal(maintenanceRuleOf(key), null, key);
    }
  });

  it('la fin d’une maintenance dit ce qui reste en panne', () => {
    const entry = {
      action: 'maintenance.ended',
      resourceType: 'maintenance_window',
      resourceId: 'w-1',
      actorId: null,
      before: null,
      after: { title: 'Noyau prod-1', held: 3, released: ['Sonde en panne — API facturation'] },
    };
    assert.equal(notifiableEventFor(entry), 'maintenance.ended');
    const message = buildNotificationMessage('maintenance.ended', entry, {
      language: 'fr',
      instance: 'Essai',
      panelUrl: 'https://panel.example.test',
      actor: null,
      occurredAt: '2026-10-03T21:00:00.000Z',
    });
    assert.equal(message.title, 'Maintenance terminée — Noyau prod-1');
    assert.match(
      message.body,
      /3 alerte\(s\) retenue\(s\)\)\. Toujours en panne, annoncé maintenant : Sonde en panne — API facturation\./,
    );
    assert.ok(message.url?.endsWith('/maintenance?fenetre=w-1'));
  });
});
