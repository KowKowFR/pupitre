import { SCANNER_KEYS, type ScannerKey } from '../scan.js';
import { GrypeScanner } from './grype.js';
import { SyftSBOM } from './syft.js';
import { TrivyScanner } from './trivy.js';
import type { Scanner } from './types.js';

export * from './types.js';
export * from './run.js';
export { TOOL_BIN, TOOL_HOME, toolPath, cachePath } from './install.js';
export { TrivyScanner, TRIVY_VERSION, normalizeTrivyReport, type TrivyOutput } from './trivy.js';
export { GrypeScanner, GRYPE_VERSION, normalizeGrypeReport, type GrypeOutput } from './grype.js';
export { SyftSBOM, SYFT_VERSION } from './syft.js';

/**
 * Scanner factory.
 *
 * Adding a scanner = adding a class and an entry here (plus the value in the
 * Postgres enum and its label in `SCANNERS`, which are data). Neither the
 * worker, nor the routes, nor the UI have to change — it is the quality bar set
 * by CLAUDE.md.
 */
const registry: Record<ScannerKey, () => Scanner> = {
  trivy: () => new TrivyScanner(),
  grype: () => new GrypeScanner(),
  syft: () => new SyftSBOM(),
};

export function getScanner(key: ScannerKey): Scanner {
  return registry[key]();
}

export function availableScanners(): ScannerKey[] {
  return [...SCANNER_KEYS];
}
