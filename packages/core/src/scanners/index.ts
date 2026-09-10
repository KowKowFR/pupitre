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
 * Fabrique de scanners.
 *
 * Ajouter un scanner = ajouter une classe et une entrée ici (plus la valeur
 * dans l'enum Postgres et son libellé dans `SCANNERS`, qui sont des données).
 * Ni le worker, ni les routes, ni l'UI n'ont à changer — c'est le critère de
 * qualité posé par CLAUDE.md.
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
