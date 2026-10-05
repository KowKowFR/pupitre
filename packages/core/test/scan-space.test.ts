import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCANNER_KEYS, type ScannerKey } from '../src/scan.js';
import {
  GIB,
  getScanner,
  parseScanSpaceProbe,
  planScanSpace,
  scanSpaceFloor,
  scanSpaceProbeCommand,
  type ScannerDiskNeed,
  type ScanSpaceProbe,
} from '../src/scanners/index.js';

const NEEDS = Object.fromEntries(
  SCANNER_KEYS.map((key) => [key, getScanner(key).diskNeed]),
) as Record<ScannerKey, ScannerDiskNeed>;

const probe = (
  freeGib: number,
  cacheGib: Partial<Record<ScannerKey, number>> = {},
): ScanSpaceProbe => ({
  totalBytes: 60 * GIB,
  freeBytes: freeGib * GIB,
  cacheBytes: Object.fromEntries(
    Object.entries(cacheGib).map(([key, gib]) => [key, (gib ?? 0) * GIB]),
  ),
});

describe('scans and the target’s disk', () => {
  it('reads the probe: the filesystem, then each cache', () => {
    const read = parseScanSpaceProbe(
      'fs 65536000 7864320\ncache trivy 1468006\ncache grype 0\ncache syft 28\n',
    );
    assert.deepEqual(read, {
      totalBytes: 65536000 * 1024,
      freeBytes: 7864320 * 1024,
      cacheBytes: { trivy: 1468006 * 1024, grype: 0, syft: 28 * 1024 },
    });
    assert.equal(parseScanSpaceProbe('cache trivy 12\n'), null, 'no filesystem line');
    assert.match(scanSpaceProbeCommand(), /df -Pk "\$HOME"/);
  });

  it('keeps 15 % of the disk free, and never less than 2 GiB', () => {
    assert.equal(scanSpaceFloor(60 * GIB), Math.ceil(60 * GIB * 0.15));
    assert.equal(scanSpaceFloor(8 * GIB), 2 * GIB);
  });

  it('every scanner declares what it may download', () => {
    for (const key of SCANNER_KEYS) {
      const need = getScanner(key).diskNeed;
      assert.ok(need.firstBytes > 0 && need.updateBytes > 0, key);
    }
  });

  it('runs everything when there is room', () => {
    const plan = planScanSpace(probe(40), ['trivy', 'grype', 'syft'], NEEDS);
    assert.deepEqual(plan.run, ['trivy', 'grype', 'syft']);
    assert.deepEqual(plan.skipped, []);
    assert.deepEqual(plan.reclaim, []);
  });

  it('removes the caches the scan does not use before giving up', () => {
    // 60 GiB disk, floor 9 GiB: 11 GiB free is not enough for Trivy's first
    // download (3 GiB) plus Syft — until Grype's unused 3 GiB cache goes.
    const plan = planScanSpace(probe(11, { grype: 3 }), ['trivy', 'syft'], NEEDS);
    assert.deepEqual(plan.reclaim, [{ scanner: 'grype', bytes: 3 * GIB }]);
    assert.deepEqual(plan.run, ['trivy', 'syft']);
  });

  it('does not run a scanner that would bring the disk under the floor', () => {
    // Floor 9 GiB: Trivy's update (1.5) fits in 11 GiB, Grype's first download (3.5) no longer does.
    const plan = planScanSpace(probe(11, { trivy: 1.4 }), ['trivy', 'grype'], NEEDS);
    assert.deepEqual(plan.run, ['trivy']);
    assert.deepEqual(plan.skipped, [{ scanner: 'grype', needBytes: NEEDS.grype.firstBytes }]);
    // A cache already there counts as an update, not a first download.
    assert.equal(NEEDS.trivy.updateBytes < NEEDS.trivy.firstBytes, true);
  });

  it('never removes the cache of a scanner the scan uses', () => {
    const plan = planScanSpace(probe(5, { trivy: 1.4, grype: 3 }), ['trivy', 'grype'], NEEDS);
    assert.deepEqual(plan.reclaim, []);
    assert.deepEqual(plan.run, []);
    assert.equal(plan.skipped.length, 2);
  });
});
