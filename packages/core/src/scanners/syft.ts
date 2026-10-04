import { SCANNERS, type ImageStore, type ScanReport } from '../scan.js';
import type { SshSession } from '../ssh/client.js';
import { cachePath, ensureBinary, toolPath } from './install.js';
import { canonicalImageReference } from '../images/reference.js';
import { shellQuote } from '../shell.js';
import {
  containerdEnv,
  MACHINE_PLATFORM_FLAG,
  parseJsonOutput,
  runTool,
  SCAN_TIMEOUT_MS,
  toolCommandFor,
  type ToolCommand,
} from './run.js';
import type { ScanContext, ScanLogSink, Scanner } from './types.js';
import { scannerSay } from './messages.js';

/**
 * Syft — inventaire des composants (SBOM CycloneDX).
 *
 * Version relevée sur `api.github.com/repos/anchore/syft/releases/latest`
 * le 2026-09-10.
 *
 * `kind = "sbom"` : cet outil n'énonce aucune vulnérabilité, donc il ne produit
 * aucun `Finding` et ne peut pas bloquer un déploiement. Ce n'est pas un cas
 * particulier codé dans le pipeline — c'est le `kind` qui le dit, et le
 * pipeline ne lit que le `kind`.
 */
export const SYFT_VERSION = '1.51.1';

/** `uname -m` → suffixe d'archive Syft. */
const ARCH_SUFFIX: Record<string, string> = {
  x86_64: 'amd64',
  amd64: 'amd64',
  aarch64: 'arm64',
  arm64: 'arm64',
  s390x: 's390x',
  ppc64le: 'ppc64le',
};

type CycloneDxDocument = {
  bomFormat?: string;
  specVersion?: string;
  components?: unknown[] | null;
};

export class SyftSBOM implements Scanner {
  readonly key = 'syft' as const;
  readonly kind = SCANNERS.syft.kind;

  async ensureInstalled(session: SshSession, onLog?: ScanLogSink): Promise<string> {
    return ensureBinary(
      session,
      this.key,
      {
        binary: 'syft',
        version: SYFT_VERSION,
        assetUrl: (arch) => {
          const suffix = ARCH_SUFFIX[arch];
          if (!suffix) return null;
          return (
            `https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}` +
            `/syft_${SYFT_VERSION}_linux_${suffix}.tar.gz`
          );
        },
      },
      onLog,
    );
  }

  async run(ctx: ScanContext, onLog: ScanLogSink): Promise<ScanReport> {
    await this.ensureInstalled(ctx.session, onLog);

    const timeout = ctx.timeoutMs ?? SCAN_TIMEOUT_MS;
    const format = SCANNERS.syft.sbomFormat ?? 'cyclonedx';
    const { command, sudo } = syftCommand(ctx.image, ctx.store, format);

    onLog(`syft ${ctx.image} -o ${format}-json`);
    const run = await runTool(ctx.session, this.key, command, onLog, timeout, sudo);
    const raw = parseJsonOutput<CycloneDxDocument>(this.key, run);

    const components = Array.isArray(raw.components) ? raw.components.length : 0;
    onLog(scannerSay(ctx.session.language)('report.components', { count: components }));

    return {
      scanner: this.key,
      kind: this.kind,
      durationMs: run.durationMs,
      // Un SBOM n'énonce pas de vulnérabilité : la liste est vide, par nature.
      findings: [],
      sbom: { format, content: run.stdout.trim() },
      raw,
    };
  }
}

/**
 * La ligne de commande de Syft pour une image et l'endroit où elle se trouve —
 * mêmes sources et même plateforme que Grype, qui s'appuie sur lui.
 */
export function syftCommand(image: string, store: ImageStore, format: string): ToolCommand {
  const cache = `SYFT_CACHE_DIR=${cachePath('syft')} SYFT_CHECK_FOR_APP_UPDATE=false`;
  switch (store.kind) {
    case 'docker':
      return {
        command: `${cache} ${toolPath('syft')} scan ${shellQuote(image)} -o ${format}-json`,
        sudo: false,
      };
    case 'containerd':
      return toolCommandFor(
        store,
        `${cache} ${containerdEnv(store)} ${toolPath('syft')} scan ${shellQuote(canonicalImageReference(image))} ` +
          `--from containerd --from registry ${MACHINE_PLATFORM_FLAG} -o ${format}-json`,
        cachePath('syft'),
      );
  }
}
