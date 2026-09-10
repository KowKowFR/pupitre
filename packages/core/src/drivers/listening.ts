import { exec } from '../ssh/client.js';
import type { DriverContext } from './types.js';

/**
 * Ports déjà en écoute sur la cible.
 *
 * La contrainte unique `(target_id, port)` empêche **deux applications du
 * panel** de se marcher dessus. Elle ne dit rien d'un service installé à la
 * main sur la machine : un Postgres sur 30001 n'a jamais demandé la permission
 * au panel. Cette sonde est le complément — la base tranche entre nos
 * réservations, la cible tranche sur ce qu'elle héberge déjà.
 *
 * `ss` est l'outil de référence, mais il vient d'`iproute2`, absent des images
 * minimales (Alpine, par exemple, n'a que le `netstat` de BusyBox). On tente
 * les deux, dans cet ordre, et on considère la sonde indisponible plutôt que de
 * conclure « aucun port occupé » à tort.
 */

const PROBE_TIMEOUT_MS = 30_000;

/**
 * Ports TCP en écoute, ou `null` si la cible n'offre aucun outil pour le dire.
 *
 * `null` et « ensemble vide » ne veulent pas dire la même chose : le premier
 * signifie « je n'ai pas pu regarder », le second « j'ai regardé, il n'y a
 * rien ». Confondre les deux ferait taire la vérification.
 */
export async function listeningPorts(ctx: DriverContext): Promise<Set<number> | null> {
  // `ss -tlnH` : TCP, en écoute, numérique, sans en-tête.
  // `-p` (processus) exige root et n'est qu'informatif : on ne le demande pas,
  // pour que la sonde fonctionne aussi sans élévation.
  const ss = await exec(ctx.sshSession, 'ss -tlnH 2>/dev/null', { timeout: PROBE_TIMEOUT_MS });
  if (ss.code === 0 && ss.stdout.trim().length > 0) {
    return parseListeningPorts(ss.stdout);
  }

  const netstat = await exec(ctx.sshSession, 'netstat -tln 2>/dev/null', {
    timeout: PROBE_TIMEOUT_MS,
  });
  if (netstat.code === 0 && netstat.stdout.trim().length > 0) {
    return parseListeningPorts(netstat.stdout);
  }

  return null;
}

/**
 * Extrait les ports de la colonne « adresse locale ».
 *
 * Les deux outils la placent au même rang, et écrivent l'adresse sous des
 * formes variées : `0.0.0.0:30001`, `[::]:30001`, `*:30001`. Le port est
 * toujours ce qui suit le dernier `:`.
 */
export function parseListeningPorts(output: string, column = 3): Set<number> {
  const ports = new Set<number>();

  for (const line of output.split('\n')) {
    const columns = line.trim().split(/\s+/);
    // `netstat` garde une ligne d'en-tête ; elle ne contient pas de `:` suivi
    // de chiffres, donc elle tombe d'elle-même.
    const address = columns[column] ?? columns[columns.length - 2];
    if (!address) continue;

    const separator = address.lastIndexOf(':');
    if (separator === -1) continue;

    const port = Number.parseInt(address.slice(separator + 1), 10);
    if (!Number.isNaN(port) && port > 0 && port <= 65_535) ports.add(port);
  }

  return ports;
}
