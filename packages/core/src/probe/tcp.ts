import { Socket } from 'node:net';
import { tcpConfigSchema, type TcpConfig } from '../monitors/catalog.js';
import type { Cidr } from '../monitors/ssrf.js';
import type { CheckResult } from '../monitors/state.js';
import type { UiLanguage } from '../i18n.js';
import { probeSay } from './messages.js';
import { ProbeTimeoutError, messageOf, resolveGuarded } from './net.js';
import type { MonitorProbe, ProbeContext } from './types.js';

/**
 * Sonde de port TCP.
 *
 * ── Ce qu'elle établit, et la nuance qui la rend utile ──────────────────────
 * La poignée TCP prouve **qu'un processus accepte les connexions**. Rien de
 * plus, et c'est déjà beaucoup : un `ECONNREFUSED` sur le port d'une base, c'est
 * le service arrêté ou le pare-feu refermé, et c'est précisément ce qu'une
 * sonde HTTP ne voit pas d'un service qui ne parle pas HTTP.
 *
 * Mais un processus figé garde sa socket d'écoute : il accepte encore la
 * poignée en étant incapable de servir. D'où la **bannière attendue**, en
 * option : SMTP, SSH, FTP, IMAP et POP3 annoncent leur identité *avant* qu'on
 * parle. Attendre `SSH-2.0` ou `220 `, c'est passer de « un port est ouvert » à
 * « le bon service, vivant, écoute derrière ».
 *
 * On n'envoie **jamais** rien — pas un octet. Une sonde constate ; solliciter un
 * service inconnu toutes les minutes le pollue (journaux d'accès, compteurs
 * anti-abus) et supposerait de savoir quel protocole il parle. Les services où
 * le client parle en premier (PostgreSQL, MySQL, HTTP) ne rendront donc jamais
 * de bannière — c'est documenté dans le catalogue, et le message d'échec le
 * rappelle.
 *
 * ── La garde, et pourquoi elle est plus critique ici qu'ailleurs ────────────
 * Une sonde qui prend un hôte et un port *est* la primitive d'un scanner de
 * réseau interne : elle rend, en clair, « ce port accepte / refuse / ne répond
 * pas », c'est-à-dire la sortie de `nmap`. Elle est **plus** dangereuse que la
 * sonde HTTP, qui au moins achoppe sur les services ne parlant pas HTTP.
 *
 * Elle passe donc par le même `resolveGuarded()` que les autres, et se connecte
 * à l'adresse **littérale** retenue : il n'y a aucune seconde résolution entre
 * le contrôle et la connexion, donc pas de fenêtre de rebinding. Aucun chemin de
 * ce fichier n'ouvre une socket vers autre chose que cette adresse.
 */

/** Ce qu'on lit d'une bannière. Au-delà, c'est du flux, pas une annonce. */
const BANNER_MAX_BYTES = 512;

type Handshake = {
  connectMs: number;
  banner: string | null;
  bannerMs: number | null;
  /** Vrai si on attendait une bannière et que le délai a expiré sans rien. */
  bannerTimedOut: boolean;
};

function connectAndListen(input: {
  address: string;
  port: number;
  timeoutMs: number;
  wantBanner: boolean;
}): Promise<Handshake> {
  // Horloge monotone : un ajustement NTP pendant la mesure ne doit pas produire
  // une latence négative ou fantaisiste.
  const started = performance.now();

  return new Promise<Handshake>((resolve, reject) => {
    let settled = false;
    let connectMs = 0;
    let connected = false;
    const chunks: Buffer[] = [];
    let size = 0;

    const socket = new Socket();
    socket.setTimeout(input.timeoutMs);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    const done = (bannerTimedOut: boolean): void => {
      const banner = chunks.length === 0 ? null : Buffer.concat(chunks).toString('utf8');
      finish(() =>
        resolve({
          connectMs,
          // Une bannière n'est pas du texte garanti : on ne garde que ce qui
          // s'imprime, sur une ligne, pour que la mesure reste lisible en base
          // et dans une alerte.
          banner: banner === null ? null : sanitizeBanner(banner),
          bannerMs: banner === null ? null : Math.round(performance.now() - started) - connectMs,
          bannerTimedOut,
        }),
      );
    };

    socket.on('connect', () => {
      connected = true;
      connectMs = Math.round(performance.now() - started);
      // Sans bannière attendue, la poignée est toute la mesure : on referme
      // immédiatement plutôt que de laisser une socket ouverte chez la cible.
      if (!input.wantBanner) done(false);
    });

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk.subarray(0, BANNER_MAX_BYTES - size));
      size += chunk.byteLength;
      // Une bannière tient sur une ligne : dès qu'on la voit finie, on n'attend
      // pas le délai complet pour rendre la main.
      if (size >= BANNER_MAX_BYTES || chunk.includes(0x0a)) done(false);
    });

    // Le service a fermé sans rien dire : on a quand même établi la connexion.
    socket.on('end', () => done(false));

    socket.on('timeout', () => {
      // Distinguer les deux délais est ce qui permet un message honnête : « le
      // port accepte mais n'annonce rien » n'est pas « le port ne répond pas ».
      if (connected) done(true);
      else finish(() => reject(new ProbeTimeoutError(input.timeoutMs)));
    });

    socket.on('error', (error) => finish(() => reject(error)));

    // Connexion à l'**adresse** contrôlée, jamais au nom : même garantie
    // anti-rebinding que les sondes HTTP et TLS.
    socket.connect({ host: input.address, port: input.port });
  });
}

function sanitizeBanner(value: string): string {
  return value
    .replace(/\r?\n/g, ' ')
    // Une bannière peut être binaire — un serveur TLS répond une alerte
    // d'octets bruts. On retire ce qui ne s'imprime pas plutôt que d'écrire des
    // caractères de contrôle en base et dans les alertes.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200);
}

async function runTcp(
  config: TcpConfig,
  allowlist: readonly Cidr[],
  language: UiLanguage,
): Promise<CheckResult> {
  const say = probeSay(language);
  let address: string;
  try {
    address = (await resolveGuarded(config.host, allowlist)).address;
  } catch (error) {
    return {
      outcome: 'unreachable',
      latencyMs: null,
      detail: messageOf(error, language),
      metrics: {},
    };
  }

  let handshake: Handshake;
  try {
    handshake = await connectAndListen({
      address,
      port: config.port,
      timeoutMs: config.timeoutMs,
      wantBanner: config.expectBanner !== null,
    });
  } catch (error) {
    // Refus, filtrage, délai : rien n'écoute de joignable. C'est
    // `unreachable`, pas `unhealthy` — la cible n'a pas répondu de travers,
    // elle n'a pas répondu.
    return {
      outcome: 'unreachable',
      latencyMs: null,
      detail: messageOf(error, language),
      metrics: { address },
    };
  }

  const metrics = {
    address,
    connectMs: handshake.connectMs,
    banner: handshake.banner,
    bannerMs: handshake.bannerMs,
  };

  if (config.expectBanner === null) {
    return { outcome: 'healthy', latencyMs: handshake.connectMs, detail: null, metrics };
  }

  if (handshake.banner === null) {
    // Le port accepte, le service ne s'annonce pas : la connexion est un
    // succès, la sonde ne l'est pas. `unhealthy` et non `unreachable` — la
    // distinction est tout l'intérêt d'attendre une bannière.
    return {
      outcome: 'unhealthy',
      latencyMs: handshake.connectMs,
      detail: handshake.bannerTimedOut
        ? say('tcp.silentBanner', { ms: config.timeoutMs })
        : say('tcp.closedSilently'),
      metrics,
    };
  }

  // Sans égard à la casse : la casse d'une bannière est fixée par le protocole,
  // pas par l'exploitant, et personne ne doit avoir à la deviner.
  const found = handshake.banner.toLowerCase().includes(config.expectBanner.toLowerCase());
  if (!found) {
    return {
      outcome: 'unhealthy',
      latencyMs: handshake.connectMs,
      detail: say('tcp.wrongBanner', { expected: config.expectBanner, banner: handshake.banner }),
      metrics,
    };
  }

  return { outcome: 'healthy', latencyMs: handshake.connectMs, detail: null, metrics };
}

export const tcpProbe: MonitorProbe = {
  type: 'tcp',
  async run(config, ctx: ProbeContext): Promise<CheckResult> {
    const parsed = tcpConfigSchema.safeParse(config);
    if (!parsed.success) {
      return {
        outcome: 'unreachable',
        latencyMs: null,
        detail: probeSay(ctx.language)('invalidConfig', {
          issues: parsed.error.issues.map((issue) => issue.message).join(', '),
        }),
        metrics: {},
      };
    }
    return runTcp(parsed.data, ctx.allowlist, ctx.language);
  },
};
