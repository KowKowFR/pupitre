import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_PORT_RANGE,
  DEPLOYMENT_STEPS,
  intersectPortRanges,
  portRangeSize,
} from '../src/index.js';
import { BACKOFF_CAP_SEC, backoffMs, parseListeningPorts } from '../src/drivers/index.js';

/**
 * Jalon 7 — la logique de cycle de vie qui n'a besoin ni de SSH ni de base.
 * Tout le reste (ufw, sondes, rollback) exige une machine : c'est
 * `scripts/verify-jalon7.sh` qui s'en charge.
 */

describe('plages de ports', () => {
  it('sans plage worker, la plage de la cible est retenue telle quelle', () => {
    assert.deepEqual(intersectPortRanges({ min: 30_000, max: 30_009 }, undefined), {
      min: 30_000,
      max: 30_009,
    });
  });

  it('garde l’intersection, jamais la dernière lue', () => {
    assert.deepEqual(
      intersectPortRanges({ min: 30_000, max: 32_767 }, { min: 30_000, max: 30_009 }),
      { min: 30_000, max: 30_009 },
    );
    assert.deepEqual(
      intersectPortRanges({ min: 31_000, max: 31_100 }, { min: 30_000, max: 31_050 }),
      { min: 31_000, max: 31_050 },
    );
  });

  it('deux plages disjointes ne produisent pas une plage vide déguisée', () => {
    assert.equal(intersectPortRanges({ min: 30_000, max: 30_009 }, { min: 31_000, max: 31_100 }), null);
  });

  it('une plage d’un seul port reste valide', () => {
    assert.deepEqual(intersectPortRanges({ min: 30_005, max: 30_005 }, { min: 30_000, max: 30_009 }), {
      min: 30_005,
      max: 30_005,
    });
  });

  it('la taille compte les deux bornes', () => {
    assert.equal(portRangeSize({ min: 30_000, max: 30_009 }), 10);
    assert.equal(portRangeSize({ min: 30_000, max: 30_000 }), 1);
    assert.equal(portRangeSize(DEFAULT_PORT_RANGE), 2768);
  });
});

describe('backoff du healthcheck', () => {
  it('double à chaque tentative', () => {
    assert.equal(backoffMs(2, 1), 2000);
    assert.equal(backoffMs(2, 2), 4000);
    assert.equal(backoffMs(2, 3), 8000);
  });

  it('plafonne : sans plafond, la dixième tentative attendrait des heures', () => {
    assert.equal(backoffMs(10, 20), BACKOFF_CAP_SEC * 1000);
    assert.ok(backoffMs(5, 10) <= BACKOFF_CAP_SEC * 1000);
  });

  it('respecte l’intervalle demandé à la première tentative', () => {
    assert.equal(backoffMs(1, 1), 1000);
    assert.equal(backoffMs(7, 1), 7000);
  });
});

describe('ports en écoute sur la cible', () => {
  it('lit la sortie de ss -tlnH', () => {
    const output = [
      'LISTEN 0      4096         0.0.0.0:22        0.0.0.0:*',
      'LISTEN 0      4096            [::]:30001        [::]:*',
      'LISTEN 0      511        127.0.0.1:30005        0.0.0.0:*',
    ].join('\n');

    assert.deepEqual([...parseListeningPorts(output)].sort((a, b) => a - b), [22, 30_001, 30_005]);
  });

  it('lit la sortie de netstat -tln, en-tête compris', () => {
    const output = [
      'Active Internet connections (only servers)',
      'Proto Recv-Q Send-Q Local Address           Foreign Address         State',
      'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN',
      'tcp        0      0 :::30002                :::*                    LISTEN',
    ].join('\n');

    assert.deepEqual([...parseListeningPorts(output)].sort((a, b) => a - b), [22, 30_002]);
  });

  it('une sortie vide ne produit aucun port — et non un port nul', () => {
    assert.equal(parseListeningPorts('').size, 0);
    assert.equal(parseListeningPorts('\n\n').size, 0);
  });
});

describe('pipeline', () => {
  it('déclare la step rollback, en dernier', () => {
    const keys = DEPLOYMENT_STEPS.map((step) => step.key);
    assert.equal(keys.at(-1), 'rollback');
    // Elle vient après le verdict qui peut la déclencher.
    assert.ok(keys.indexOf('healthcheck') < keys.indexOf('rollback'));
  });

  it('chaque step a une clé unique', () => {
    const keys = DEPLOYMENT_STEPS.map((step) => step.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});
