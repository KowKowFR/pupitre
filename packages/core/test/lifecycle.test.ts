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
 * The life-cycle logic that needs neither SSH nor a database. Everything else
 * (ufw, probes, rollback) requires a machine: `scripts/verify-ports-rollback.sh`
 * takes care of it.
 */

describe('plages de ports', () => {
  it('without a worker range, the target’s range is kept as is', () => {
    assert.deepEqual(intersectPortRanges({ min: 30_000, max: 30_009 }, undefined), {
      min: 30_000,
      max: 30_009,
    });
  });

  it('keeps the intersection, never the last one read', () => {
    assert.deepEqual(
      intersectPortRanges({ min: 30_000, max: 32_767 }, { min: 30_000, max: 30_009 }),
      { min: 30_000, max: 30_009 },
    );
    assert.deepEqual(
      intersectPortRanges({ min: 31_000, max: 31_100 }, { min: 30_000, max: 31_050 }),
      { min: 31_000, max: 31_050 },
    );
  });

  it('two disjoint ranges do not produce a disguised empty range', () => {
    assert.equal(intersectPortRanges({ min: 30_000, max: 30_009 }, { min: 31_000, max: 31_100 }), null);
  });

  it('a single-port range stays valid', () => {
    assert.deepEqual(intersectPortRanges({ min: 30_005, max: 30_005 }, { min: 30_000, max: 30_009 }), {
      min: 30_005,
      max: 30_005,
    });
  });

  it('the size counts both bounds', () => {
    assert.equal(portRangeSize({ min: 30_000, max: 30_009 }), 10);
    assert.equal(portRangeSize({ min: 30_000, max: 30_000 }), 1);
    assert.equal(portRangeSize(DEFAULT_PORT_RANGE), 2768);
  });
});

describe('backoff du healthcheck', () => {
  it('doubles at each attempt', () => {
    assert.equal(backoffMs(2, 1), 2000);
    assert.equal(backoffMs(2, 2), 4000);
    assert.equal(backoffMs(2, 3), 8000);
  });

  it('caps: without a cap, the tenth attempt would wait for hours', () => {
    assert.equal(backoffMs(10, 20), BACKOFF_CAP_SEC * 1000);
    assert.ok(backoffMs(5, 10) <= BACKOFF_CAP_SEC * 1000);
  });

  it('respects the requested interval at the first attempt', () => {
    assert.equal(backoffMs(1, 1), 1000);
    assert.equal(backoffMs(7, 1), 7000);
  });
});

describe('ports listening on the target', () => {
  it('lit la sortie de ss -tlnH', () => {
    const output = [
      'LISTEN 0      4096         0.0.0.0:22        0.0.0.0:*',
      'LISTEN 0      4096            [::]:30001        [::]:*',
      'LISTEN 0      511        127.0.0.1:30005        0.0.0.0:*',
    ].join('\n');

    assert.deepEqual([...parseListeningPorts(output)].sort((a, b) => a - b), [22, 30_001, 30_005]);
  });

  it('reads netstat -tln’s output, header included', () => {
    const output = [
      'Active Internet connections (only servers)',
      'Proto Recv-Q Send-Q Local Address           Foreign Address         State',
      'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN',
      'tcp        0      0 :::30002                :::*                    LISTEN',
    ].join('\n');

    assert.deepEqual([...parseListeningPorts(output)].sort((a, b) => a - b), [22, 30_002]);
  });

  it('an empty output produces no port — and not a zero port', () => {
    assert.equal(parseListeningPorts('').size, 0);
    assert.equal(parseListeningPorts('\n\n').size, 0);
  });
});

describe('pipeline', () => {
  it('declares the rollback step, last', () => {
    const keys = DEPLOYMENT_STEPS.map((step) => step.key);
    assert.equal(keys.at(-1), 'rollback');
    // It comes after the verdict that can trigger it.
    assert.ok(keys.indexOf('healthcheck') < keys.indexOf('rollback'));
  });

  it('each step has a unique key', () => {
    const keys = DEPLOYMENT_STEPS.map((step) => step.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});
