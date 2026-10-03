import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  countFlips,
  describeForecast,
  fitLine,
  forecastBackup,
  forecastCertificate,
  forecastDeploys,
  forecastDisk,
  forecastFlapping,
  forecastLatency,
  forecastLoad,
  forecastMemory,
  type SeriesPoint,
} from '../src/forecast.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-03T12:00:00Z');
const subject = { type: 'target' as const, id: 't1', name: 'prod-1' };

/** Une série horaire sur `days` jours qui finit maintenant. */
function series(days: number, value: (dayIndex: number, hour: number) => number): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  const hours = days * 24;
  for (let h = hours; h >= 0; h -= 1) {
    points.push({ t: NOW - h * HOUR, v: value((hours - h) / 24, h % 24) });
  }
  return points;
}

describe('prévisions', () => {
  it('trace une droite et dit sa netteté', () => {
    const fit = fitLine(series(3, (d) => 50 + 2 * d));
    assert.ok(Math.abs(fit.slopePerDay - 2) < 0.01);
    assert.ok(fit.r2 > 0.99);
  });

  it('prévoit un disque plein, avec la date et le rythme', () => {
    // 70 % aujourd'hui, +3 points par jour, un peu de bruit : plein à 95 % dans ~8 jours.
    const points = series(7, (d, h) => 49 + 3 * d + ((h * 7) % 5) / 10);
    const forecast = forecastDisk(subject, points, NOW, 200);
    assert.ok(forecast);
    assert.equal(forecast.kind, 'disk_full');
    assert.equal(forecast.severity, 'watch');
    assert.ok(
      Math.abs(Number(forecast.detail.etaDays) - 8.3) < 0.5,
      String(forecast.detail.etaDays),
    );
    assert.ok(Math.abs(Number(forecast.detail.gibPerDay) - 6) < 0.3);
  });

  it('se tait sur un disque stable, bruyant, ou trop loin du mur', () => {
    assert.equal(
      forecastDisk(
        subject,
        series(7, () => 60),
        NOW,
        200,
      ),
      null,
      'stable',
    );
    assert.equal(
      forecastDisk(
        subject,
        series(7, (d, h) => 60 + (h % 2 ? 15 : -15) + d * 0.5),
        NOW,
        200,
      ),
      null,
      'bruit sans tendance nette',
    );
    assert.equal(
      forecastDisk(
        subject,
        series(7, (d) => 20 + 0.5 * d),
        NOW,
        200,
      ),
      null,
      'mur dans 150 jours',
    );
    assert.equal(
      forecastDisk(
        subject,
        series(1, (d) => 70 + 10 * d),
        NOW,
        200,
      ),
      null,
      'pas assez de recul',
    );
  });

  it('dit « bientôt » quand le mur est à trois jours', () => {
    const forecast = forecastDisk(
      subject,
      series(4, (d) => 74 + 4 * d),
      NOW,
      null,
    );
    assert.ok(forecast);
    assert.equal(forecast.severity, 'soon');
    assert.equal(forecast.detail.gibPerDay, null);
  });

  it('voit une fuite de mémoire, pas une mémoire qui respire', () => {
    assert.ok(
      forecastMemory(
        subject,
        series(2, (d) => 60 + 8 * d),
        NOW,
      ),
    );
    assert.equal(
      forecastMemory(
        subject,
        series(2, (_d, h) => 60 + (h < 12 ? h : 24 - h)),
        NOW,
      ),
      null,
    );
  });

  it('voit une charge qui monte vers le seuil de la machine', () => {
    const forecast = forecastLoad(
      subject,
      series(5, (d) => 40 + 6 * d),
      85,
      NOW,
    );
    assert.ok(forecast);
    assert.equal(forecast.detail.limit, 85);
  });

  it('voit une sonde qui ralentit, pas un écart insignifiant', () => {
    const monitor = { type: 'monitor' as const, id: 'm1', name: 'API' };
    assert.ok(
      forecastLatency(monitor, {
        recentMedian: 450,
        recentCount: 60,
        baselineMedian: 200,
        baselineCount: 500,
      }),
    );
    assert.equal(
      forecastLatency(monitor, {
        recentMedian: 70,
        recentCount: 60,
        baselineMedian: 40,
        baselineCount: 500,
      }),
      null,
      '+30 ms',
    );
    assert.equal(
      forecastLatency(monitor, {
        recentMedian: 900,
        recentCount: 5,
        baselineMedian: 200,
        baselineCount: 500,
      }),
      null,
      'trop peu de mesures',
    );
  });

  it('compte les bascules d’une sonde instable', () => {
    assert.equal(countFlips(['healthy', 'unhealthy', 'healthy', 'unreachable', 'unhealthy']), 3);
    assert.equal(forecastFlapping(subject, 5), null);
    assert.equal(forecastFlapping(subject, 12)?.severity, 'soon');
  });

  it('signale un certificat que personne n’a renouvelé', () => {
    const route = { type: 'route' as const, id: 'r1', name: 'blog.exemple.fr' };
    assert.ok(forecastCertificate(route, new Date(NOW + 12 * DAY).toISOString(), NOW));
    assert.equal(forecastCertificate(route, new Date(NOW + 45 * DAY).toISOString(), NOW), null);
    assert.equal(
      forecastCertificate(route, new Date(NOW - DAY).toISOString(), NOW),
      null,
      'déjà échu',
    );
  });

  it('signale une sauvegarde qui ne tourne plus', () => {
    const app = { type: 'application' as const, id: 'a1', name: 'blog' };
    const since = new Date(NOW - 10 * DAY).toISOString();
    assert.ok(forecastBackup(app, new Date(NOW - 3 * DAY).toISOString(), since, NOW));
    assert.equal(forecastBackup(app, new Date(NOW - 20 * HOUR).toISOString(), since, NOW), null);
    assert.equal(
      forecastBackup(app, null, new Date(NOW - 5 * DAY).toISOString(), NOW)?.detail.never,
      1,
    );
  });

  it('signale des déploiements qui échouent en série', () => {
    const recent = (statuses: string[]) =>
      statuses.map((status, index) => ({
        status,
        createdAt: new Date(NOW - index * HOUR).toISOString(),
      }));
    assert.ok(forecastDeploys(subject, recent(['failed', 'rolled_back', 'failed']), NOW));
    assert.equal(forecastDeploys(subject, recent(['failed', 'success', 'failed']), NOW), null);
    assert.equal(forecastDeploys(subject, recent(['failed', 'failed']), NOW), null);
  });

  it('dit une prévision en phrase, nombres dans la langue', () => {
    const forecast = forecastDisk(
      subject,
      series(7, (d) => 49 + 3 * d),
      NOW,
      200,
    )!;
    const fr = describeForecast(forecast, 'fr');
    assert.equal(fr.title, 'Disque bientôt plein');
    assert.match(
      fr.sentence,
      /« prod-1 » sera plein \(95 %\) dans ~8 jours : il gagne 3 points par jour \(6 Gio\)/,
    );
    const en = describeForecast(forecast, 'en');
    assert.match(en.sentence, /in ~8 days: it gains 3 points a day \(6 GiB\)/);
    const backup = describeForecast(
      {
        kind: 'backup_stale',
        subject: { type: 'application', id: 'a', name: 'blog' },
        detail: { hours: 60, never: 1 },
      },
      'fr',
    );
    assert.match(backup.sentence, /jamais été sauvegardée, 60 h/);
    const memory = describeForecast(
      { kind: 'memory_growth', subject, detail: { ratePerDay: 8, etaDays: 1.4 } },
      'fr',
    );
    assert.match(memory.sentence, /95 % dans ~34 heures/);
  });
});
