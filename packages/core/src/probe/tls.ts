import { connect, type PeerCertificate, type TLSSocket } from 'node:tls';
import { tlsConfigSchema, type TlsConfig } from '../monitors/catalog.js';
import type { Cidr } from '../monitors/ssrf.js';
import type { CheckResult } from '../monitors/state.js';
import { SsrfBlockedError, messageOf, resolveGuarded } from './net.js';
import type { MonitorProbe, ProbeContext } from './types.js';

/**
 * Sonde de certificat TLS.
 *
 * Elle existe pour prévenir la panne la plus bête et la plus totale qui soit :
 * un certificat expiré, que personne ne voit venir. Une poignée de main, puis
 * `getPeerCertificate()` — aucune dépendance.
 *
 * C'est aussi la preuve que l'abstraction tient : ce type n'est **pas** une
 * requête HTTP, et il n'a fallu toucher ni à la table, ni au runner, ni aux
 * routes, ni à l'écran pour l'ajouter.
 *
 * ── Le choix qui mérite d'être écrit ────────────────────────────────────────
 * Un certificat qui expire dans dix jours fait passer la sonde en **échec**, pas
 * en simple avertissement. Une sonde de certificat n'a d'intérêt que si elle
 * alerte *avant* la panne ; attendre l'expiration reviendrait à constater
 * l'incendie. La conséquence est assumée et documentée dans le catalogue : le
 * taux de disponibilité d'une sonde TLS se lit « part du temps où le certificat
 * était valide **et hors préavis** ».
 */

const MS_PER_DAY = 86_400_000;

/** `subject` et `issuer` sont des objets de champs X.509 ; on en tire une ligne. */
function distinguishedName(fields: PeerCertificate['issuer'] | undefined): string | null {
  if (!fields) return null;
  const record = fields as unknown as Record<string, string | string[] | undefined>;
  // CN d'abord, O ensuite : c'est ce qu'un humain reconnaît d'un émetteur.
  for (const key of ['CN', 'O', 'OU']) {
    const value = record[key];
    const text = Array.isArray(value) ? value[0] : value;
    if (typeof text === 'string' && text !== '') return text;
  }
  return null;
}

function handshake(input: {
  address: string;
  port: number;
  servername: string;
  timeoutMs: number;
}): Promise<{ socket: TLSSocket; elapsedMs: number }> {
  // Horloge monotone : un ajustement NTP pendant la mesure ne doit pas
  // produire une latence négative ou fantaisiste.
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const socket = connect({
      // Connexion à l'**adresse** contrôlée, SNI et vérification sur le nom :
      // même garantie que la sonde HTTP contre le rebinding DNS.
      host: input.address,
      port: input.port,
      servername: input.servername,
      // On veut savoir si la chaîne est valide — c'est la moitié de l'intérêt.
      rejectUnauthorized: true,
      timeout: input.timeoutMs,
    });

    socket.once('secureConnect', () =>
      finish(() => resolve({ socket, elapsedMs: Math.round(performance.now() - started) })),
    );
    socket.once('timeout', () =>
      finish(() => {
        socket.destroy();
        reject(new Error(`délai dépassé après ${input.timeoutMs} ms`));
      }),
    );
    socket.once('error', (error) => finish(() => reject(error)));
  });
}

async function runTls(config: TlsConfig, allowlist: readonly Cidr[]): Promise<CheckResult> {
  const servername = config.servername ?? config.host;

  let address: string;
  try {
    address = (await resolveGuarded(config.host, allowlist)).address;
  } catch (error) {
    return {
      outcome: 'unreachable',
      latencyMs: null,
      detail: error instanceof SsrfBlockedError ? error.reason : messageOf(error),
      metrics: {},
    };
  }

  let socket: TLSSocket;
  let elapsedMs: number;
  try {
    ({ socket, elapsedMs } = await handshake({
      address,
      port: config.port,
      servername,
      timeoutMs: config.timeoutMs,
    }));
  } catch (error) {
    // Une chaîne invalide ou un nom qui ne correspond pas remonte ici : c'est
    // bien une panne du certificat, mais on ne saurait pas la distinguer d'un
    // port fermé sans inspecter le code. On le fait.
    const code = (error as NodeJS.ErrnoException).code ?? '';
    const certificateProblem =
      code.startsWith('CERT_') ||
      code.startsWith('ERR_TLS') ||
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
      code === 'HOSTNAME_MISMATCH';
    return {
      outcome: certificateProblem ? 'unhealthy' : 'unreachable',
      latencyMs: null,
      detail: messageOf(error),
      metrics: { address },
    };
  }

  try {
    const certificate = socket.getPeerCertificate(false);
    const protocol = socket.getProtocol();

    if (!certificate.valid_to) {
      return {
        outcome: 'unhealthy',
        latencyMs: elapsedMs,
        detail: 'aucun certificat présenté',
        metrics: { address, protocol, handshakeMs: elapsedMs },
      };
    }

    const validTo = new Date(certificate.valid_to);
    const validFrom = certificate.valid_from ? new Date(certificate.valid_from) : null;
    const now = Date.now();
    // Arrondi vers le bas : « 0 jour restant » le jour de l'expiration, pas 1.
    const daysRemaining = Math.floor((validTo.getTime() - now) / MS_PER_DAY);

    const metrics = {
      address,
      protocol,
      handshakeMs: elapsedMs,
      daysRemaining,
      validTo: validTo.toISOString(),
      validFrom: validFrom?.toISOString() ?? null,
      issuer: distinguishedName(certificate.issuer),
      subject: distinguishedName(certificate.subject),
      serialNumber: certificate.serialNumber ?? null,
    };

    if (Number.isNaN(validTo.getTime())) {
      return {
        outcome: 'unhealthy',
        latencyMs: elapsedMs,
        detail: `date d'expiration illisible « ${certificate.valid_to} »`,
        metrics,
      };
    }
    if (validTo.getTime() <= now) {
      return {
        outcome: 'unhealthy',
        latencyMs: elapsedMs,
        detail: `certificat expiré depuis ${Math.abs(daysRemaining)} jour(s)`,
        metrics,
      };
    }
    if (validFrom && validFrom.getTime() > now) {
      return {
        outcome: 'unhealthy',
        latencyMs: elapsedMs,
        detail: 'certificat pas encore valide',
        metrics,
      };
    }
    if (daysRemaining <= config.warnDays) {
      return {
        outcome: 'unhealthy',
        latencyMs: elapsedMs,
        detail: `certificat expire dans ${daysRemaining} jour(s), préavis réglé à ${config.warnDays}`,
        metrics,
      };
    }

    return { outcome: 'healthy', latencyMs: elapsedMs, detail: null, metrics };
  } finally {
    socket.destroy();
  }
}

export const tlsProbe: MonitorProbe = {
  type: 'tls',
  async run(config, ctx: ProbeContext): Promise<CheckResult> {
    const parsed = tlsConfigSchema.safeParse(config);
    if (!parsed.success) {
      return {
        outcome: 'unreachable',
        latencyMs: null,
        detail: `configuration de sonde invalide : ${parsed.error.issues.map((issue) => issue.message).join(', ')}`,
        metrics: {},
      };
    }
    return runTls(parsed.data, ctx.allowlist);
  },
};
