import { SCANNER_KEYS, type ScannerKey } from '../scan.js';
import { cachePath } from './install.js';

/**
 * Disk space and scanners, on the target.
 *
 * A vulnerability database weighs gigabytes — Grype's about 3 GB, Trivy's 1.4 GB,
 * plus 1.4 GB more the first time it meets Java —, and the tool downloads it on
 * the machine it scans, next to the applications. On a disk already full, a scan
 * finished filling it: PostgreSQL then refused to write, and a K3s node evicted
 * its pods. So a scan first checks it leaves room, and gives way when it does not.
 *
 * Pure functions here: the shell probe, its reading, and the plan. The worker
 * runs them; the tests read them without SSH.
 */

export const GIB = 1024 ** 3;

/** What a scanner may download into its cache on the target, at worst. */
export type ScannerDiskNeed = {
  /** First pass: the database is downloaded whole. */
  firstBytes: number;
  /** Later passes: an update can download a new database next to the old one. */
  updateBytes: number;
};

/**
 * What a scan always leaves free: 15 % of the disk, and never less than 2 GiB.
 * Fifteen percent is the line under which kubelet considers its image space
 * under pressure and starts evicting pods: a scan must not be what crosses it.
 */
export function scanSpaceFloor(totalBytes: number): number {
  return Math.max(2 * GIB, Math.ceil(totalBytes * 0.15));
}

export type ScanSpaceProbe = {
  totalBytes: number;
  freeBytes: number;
  /** The size of each scanner's cache; `0` when it does not exist yet. */
  cacheBytes: Partial<Record<ScannerKey, number>>;
};

/**
 * The shell probe: the filesystem that holds the tools (`df -Pk`, whose POSIX
 * format is stable), then the size of each scanner's cache.
 */
export function scanSpaceProbeCommand(): string {
  const lines = [`df -Pk "$HOME" | awk 'NR==2 {print "fs", $2, $4}'`];
  for (const key of SCANNER_KEYS) {
    const dir = cachePath(key);
    lines.push(
      `if [ -d ${dir} ]; then printf 'cache ${key} %s\\n' "$(du -sk ${dir} 2>/dev/null | cut -f1)"; ` +
        `else echo 'cache ${key} 0'; fi`,
    );
  }
  return lines.join('\n');
}

/** The probe's output, read; `null` when the filesystem line is missing. */
export function parseScanSpaceProbe(stdout: string): ScanSpaceProbe | null {
  let totalBytes: number | null = null;
  let freeBytes: number | null = null;
  const cacheBytes: Partial<Record<ScannerKey, number>> = {};
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === 'fs' && fields.length === 3) {
      totalBytes = Number(fields[1]) * 1024;
      freeBytes = Number(fields[2]) * 1024;
    } else if (fields[0] === 'cache' && fields.length === 3) {
      const key = fields[1] as ScannerKey;
      const kib = Number(fields[2]);
      if (SCANNER_KEYS.includes(key) && Number.isFinite(kib)) cacheBytes[key] = kib * 1024;
    }
  }
  if (totalBytes === null || freeBytes === null) return null;
  if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes)) return null;
  return { totalBytes, freeBytes, cacheBytes };
}

export type ScanSpacePlan = {
  floorBytes: number;
  freeBytes: number;
  /** Caches of scanners this scan does not use, removed to make room. */
  reclaim: Array<{ scanner: ScannerKey; bytes: number }>;
  run: ScannerKey[];
  /** Scanners that would leave less than the floor: not run. */
  skipped: Array<{ scanner: ScannerKey; needBytes: number }>;
};

/**
 * Which scanners can run without bringing the disk under the floor.
 *
 * Every selected scanner counts its worst download — whole when its cache is
 * empty, an update otherwise —, and the space it may take is set aside for the
 * next ones. When that does not fit, the caches of the scanners this scan does
 * not use are removed first: they would be downloaded again the day they are
 * chosen, but meanwhile they take room for nothing. Whatever still does not fit
 * is skipped, in the selection's order.
 */
export function planScanSpace(
  probe: ScanSpaceProbe,
  selected: readonly ScannerKey[],
  needs: Readonly<Record<ScannerKey, ScannerDiskNeed>>,
): ScanSpacePlan {
  const floorBytes = scanSpaceFloor(probe.totalBytes);
  const need = (key: ScannerKey): number =>
    (probe.cacheBytes[key] ?? 0) > 0 ? needs[key].updateBytes : needs[key].firstBytes;

  let free = probe.freeBytes;
  const reclaim: ScanSpacePlan['reclaim'] = [];
  const wanted = selected.reduce((sum, key) => sum + need(key), 0);
  if (free - wanted < floorBytes) {
    for (const key of SCANNER_KEYS) {
      const bytes = probe.cacheBytes[key] ?? 0;
      if (!selected.includes(key) && bytes > 0) {
        reclaim.push({ scanner: key, bytes });
        free += bytes;
      }
    }
  }

  const run: ScannerKey[] = [];
  const skipped: ScanSpacePlan['skipped'] = [];
  for (const key of selected) {
    const needBytes = need(key);
    if (free - needBytes >= floorBytes) {
      run.push(key);
      free -= needBytes;
    } else {
      skipped.push({ scanner: key, needBytes });
    }
  }
  return { floorBytes, freeBytes: probe.freeBytes, reclaim, run, skipped };
}
