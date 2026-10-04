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

describe('maintenance — the window', () => {
  const window = { startsAt: '2026-10-03T20:00:00Z', endsAt: '2026-10-03T21:00:00Z' };

  it('upcoming, ongoing, finished — start included, end excluded', () => {
    assert.equal(maintenancePhase(window, T('2026-10-03T19:59:59Z')), 'upcoming');
    assert.equal(maintenancePhase(window, T('2026-10-03T20:00:00Z')), 'active');
    assert.equal(maintenancePhase(window, T('2026-10-03T20:59:59Z')), 'active');
    assert.equal(maintenancePhase(window, T('2026-10-03T21:00:00Z')), 'ended');
  });

  it('refuses an end before the start, a window longer than a month, an empty window', () => {
    const base = { title: 'Mise à jour du noyau', ...window, targetIds: [crypto.randomUUID()] };
    assert.ok(createMaintenanceSchema.safeParse(base).success);
    const reversed = createMaintenanceSchema.safeParse({ ...base, endsAt: base.startsAt });
    assert.ok(!reversed.success && reversed.error.issues[0]?.path[0] === 'endsAt');
    const long = createMaintenanceSchema.safeParse({ ...base, endsAt: '2026-11-10T00:00:00Z' });
    assert.ok(!long.success);
    const empty = createMaintenanceSchema.safeParse({ ...base, targetIds: [] });
    assert.ok(!empty.success && empty.error.issues[0]?.path[0] === 'targetIds');
  });

  it('input speaks the instance’s time zone, daylight saving time included', () => {
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

describe('maintenance — held alerts', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 3, 20, minute));
  const held = (id: string, family: string, opens: boolean, minute: number) => ({
    id,
    family,
    opens,
    heldAt: at(minute),
  });

  it('an outage repaired during the window does not go out; an outage still there does', () => {
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

  it('a recovery alone does not go out', () => {
    assert.deepEqual(alertsToRelease([held('a', 'reach:prod-1', false, 5)]), []);
  });
});

describe('maintenance — the catalog', () => {
  it('monitoring alerts have a rule; security and deployments, never', () => {
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
    // An entry written before the route was in it: never held.
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

  it('the end of a maintenance window says what stays down', () => {
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
