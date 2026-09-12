import type { ScannerKey } from '../scan.js';
import { exec } from '../ssh/client.js';
import type { SshSession } from '../ssh/client.js';
import { ScannerError, type ScanLogSink } from './types.js';

/**
 * Installation des outils sur la machine cible.
 *
 * Les trois scanners sont des binaires Go statiques distribués en `tar.gz` sur
 * les releases GitHub : la mécanique est la même pour tous, seuls le nom de
 * l'archive et la traduction de `uname -m` changent. Elle est donc écrite ici,
 * une fois, et chaque implémentation ne fournit que ce qui lui est propre.
 *
 * Rien n'est installé par le gestionnaire de paquets : la cible n'est pas
 * forcément Debian, et les dépôts distribuent des versions arbitrairement
 * anciennes — un scanner de sécurité périmé est pire qu'aucun scanner.
 */

/** Racine de travail des scanners sur la cible. */
/**
 * Où les binaires de scan sont posés sur la machine cible.
 *
 * **Ce chemin ne suit pas le renommage, volontairement.** C'est un cache déjà
 * rempli sur chaque cible : Trivy, Grype et Syft y sont installés, avec leurs
 * bases de vulnérabilités. Le déplacer ne rendrait service à personne — le
 * répertoire n'apparaît nulle part dans l'interface — et coûterait un
 * re-téléchargement complet sur toutes les cibles au premier scan suivant,
 * plus un répertoire orphelin laissé derrière.
 */
export const TOOL_HOME = '"$HOME"/.bootstrap-tp';
export const TOOL_BIN = `${TOOL_HOME}/bin`;

export const INSTALL_TIMEOUT_MS = 5 * 60_000;
const VERSION_TIMEOUT_MS = 60_000;

export type ReleaseAsset = {
  /** Nom du binaire une fois installé, ex. `trivy`. */
  binary: string;
  /** Version épinglée, sans le `v` initial. */
  version: string;
  /**
   * URL de l'archive pour une architecture telle que la rapporte `uname -m`.
   * `null` quand l'outil ne publie rien pour cette architecture.
   */
  assetUrl: (arch: string) => string | null;
};

export function toolPath(binary: string): string {
  return `${TOOL_BIN}/${binary}`;
}

/** Chemin des caches, isolé par outil. */
export function cachePath(binary: string): string {
  return `${TOOL_HOME}/cache/${binary}`;
}

/**
 * Installe l'outil s'il est absent ou périmé, puis retourne sa version.
 *
 * La détection passe par `--version` : c'est l'outil lui-même qui répond, pas
 * un fichier marqueur qu'un `rm` mal placé rendrait menteur.
 */
export async function ensureBinary(
  session: SshSession,
  scanner: ScannerKey,
  asset: ReleaseAsset,
  onLog?: ScanLogSink,
): Promise<string> {
  const installed = await readVersion(session, asset.binary);
  if (installed !== null && installed.includes(asset.version)) {
    onLog?.(`${asset.binary} ${asset.version} déjà présent`);
    return asset.version;
  }

  const uname = await exec(session, 'uname -m', { timeout: VERSION_TIMEOUT_MS });
  const arch = uname.stdout.trim();
  if (uname.code !== 0 || arch.length === 0) {
    throw new ScannerError(
      "impossible de déterminer l'architecture de la cible (`uname -m`)",
      scanner,
      'install',
    );
  }

  const url = asset.assetUrl(arch);
  if (url === null) {
    throw new ScannerError(
      `${asset.binary} ne publie pas de binaire pour l'architecture « ${arch} »`,
      scanner,
      'install',
    );
  }

  onLog?.(
    installed === null
      ? `installation de ${asset.binary} ${asset.version} (${arch})`
      : `mise à jour de ${asset.binary} vers ${asset.version} (${arch})`,
  );

  const script = [
    'set -e',
    `mkdir -p ${TOOL_BIN}`,
    'tmp="$(mktemp -d)"',
    `trap 'rm -rf "$tmp"' EXIT`,
    `curl -fsSL --retry 3 --connect-timeout 20 -o "$tmp"/asset.tar.gz ${shellQuote(url)}`,
    `tar -xzf "$tmp"/asset.tar.gz -C "$tmp" ${shellQuote(asset.binary)}`,
    `chmod 0755 "$tmp"/${asset.binary}`,
    `mv -f "$tmp"/${asset.binary} ${toolPath(asset.binary)}`,
  ].join('\n');

  const result = await exec(session, script, { timeout: INSTALL_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new ScannerError(
      `installation de ${asset.binary} impossible : ${firstLine(result.stderr) ?? `code ${result.code}`}`,
      scanner,
      'install',
    );
  }

  const confirmed = await readVersion(session, asset.binary);
  if (confirmed === null) {
    throw new ScannerError(
      `${asset.binary} reste injoignable après installation`,
      scanner,
      'install',
    );
  }

  onLog?.(`${asset.binary} installé — ${confirmed}`);
  return confirmed;
}

/** Version rapportée par l'outil, ou `null` s'il n'est pas installé. */
async function readVersion(session: SshSession, binary: string): Promise<string | null> {
  const result = await exec(session, `${toolPath(binary)} --version 2>&1 || true`, {
    timeout: VERSION_TIMEOUT_MS,
    logOutput: false,
  });
  const text = `${result.stdout}\n${result.stderr}`.trim();
  if (text.length === 0) return null;
  if (/not found|No such file|Permission denied/i.test(text)) return null;
  return text.split('\n')[0]?.trim() ?? null;
}

/** Échappement POSIX en quotes simples. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function firstLine(value: string): string | null {
  const line = value.split('\n').find((candidate) => candidate.trim().length > 0);
  return line?.trim() ?? null;
}
