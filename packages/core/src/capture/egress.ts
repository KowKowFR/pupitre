import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import type { Cidr } from '../monitors/ssrf.js';
import { SsrfBlockedError, resolveGuarded } from '../probe/net.js';

/**
 * **Le mandataire de sortie du navigateur de capture.**
 *
 * ── Pourquoi il existe : une hypothèse qui s'est révélée fausse ─────────────
 * L'intention de départ était purement topologique : mettre le navigateur sur
 * un réseau Compose à lui, sans route vers la pile, et considérer l'affaire
 * close. Un réseau sans route ne s'oublie pas, là où une garde applicative dans
 * le navigateur s'oublie — le raisonnement était bon.
 *
 * **Il a été mesuré, et il est faux.** Sur Docker Engine 29 / Docker Desktop,
 * deux réseaux `bridge` distincts d'un même projet ne sont pas isolés l'un de
 * l'autre : depuis le réseau `capture`, un conteneur joint `postgres`, `redis`
 * et `panel` par leur adresse IP. Le nom ne résout plus — c'est tout ce que le
 * réseau séparé apporte — et deviner `172.x.0.4` n'est pas un obstacle.
 *
 * Ce qui isole réellement, et qui a été mesuré aussi : **`internal: true`**. Un
 * réseau interne n'a pas de passerelle du tout ; la table de routage du
 * conteneur tient en une ligne, celle de son propre /16. Rien d'autre n'est
 * *routable*, ni la pile, ni l'hôte, ni l'Internet.
 *
 * Mais alors le navigateur ne peut plus rien capturer. D'où ce mandataire : le
 * navigateur est enfermé sur un réseau interne d'où **la seule chose joignable
 * est le worker**, et il est lancé avec `--proxy-server` vers celui-ci. Toute
 * sortie — page principale, redirections, sous-ressources, requêtes émises par
 * le JavaScript de la page — passe par ici, et par la garde SSRF déjà écrite.
 *
 * ── Ce que ça garantit, et pourquoi c'est plus fort que l'intention ─────────
 * Une page hostile ne peut pas contourner la configuration de mandataire de son
 * navigateur : la plateforme web n'offre pas de socket brute. Et si quelqu'un
 * retirait un jour l'option `--proxy-server`, le navigateur ne perdrait pas sa
 * garde — il perdrait l'Internet, et la panne serait immédiate et visible.
 * C'est la propriété qu'on cherchait : **une garde qu'on ne peut pas oublier
 * silencieusement.**
 *
 * ── Ce que ça ne garantit pas ───────────────────────────────────────────────
 * Le mandataire filtre des **adresses**, pas des contenus. Une page publique
 * hostile reste libre de faire émettre au worker des requêtes vers d'autres
 * adresses publiques — exactement ce que la sonde HTTP fait déjà, et exactement
 * ce que `MONITOR_ALLOWED_CIDRS` borne. Il n'y a pas de nouveau pouvoir ici, il
 * y a le même, appliqué au navigateur.
 *
 * Et ce mandataire n'est **pas** un mandataire à ouvrir sur le monde : il écoute
 * sur les réseaux Compose du worker, jamais sur l'hôte, et ne démarre pas quand
 * la capture est éteinte.
 */

export type CaptureEgressOptions = {
  allowlist: readonly Cidr[];
  port: number;
  /** Interface d'écoute. `0.0.0.0` : le navigateur est sur un autre réseau. */
  host?: string;
  /** Journalisation des refus. Le worker y branche Pino. */
  onBlocked?: (target: string, reason: string) => void;
};

export type CaptureEgress = {
  server: Server;
  port: number;
  close: () => Promise<void>;
};

/** `host:port` d'une demande CONNECT, ou d'une URL absolue. */
function splitAuthority(authority: string, fallbackPort: number): { host: string; port: number } {
  const trimmed = authority.trim();
  // IPv6 littéral : `[::1]:443`.
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end > 0) {
      const host = trimmed.slice(1, end);
      const rest = trimmed.slice(end + 1);
      const port = rest.startsWith(':') ? Number(rest.slice(1)) : fallbackPort;
      return { host, port: Number.isFinite(port) && port > 0 ? port : fallbackPort };
    }
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon < 0) return { host: trimmed, port: fallbackPort };
  const port = Number(trimmed.slice(colon + 1));
  return {
    host: trimmed.slice(0, colon),
    port: Number.isFinite(port) && port > 0 ? port : fallbackPort,
  };
}

/**
 * En-têtes de saut en saut : elles décrivent la connexion au mandataire, pas la
 * requête. Les retransmettre casse le keep-alive et fuite notre existence.
 */
const HOP_BY_HOP = new Set([
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function createCaptureEgress(options: CaptureEgressOptions): Promise<CaptureEgress> {
  const { allowlist } = options;

  const refuse = (target: string, reason: string): void => {
    options.onBlocked?.(target, reason);
  };

  /**
   * La garde, en un seul endroit pour les deux chemins (CONNECT et HTTP en
   * clair). Elle rend l'**adresse littérale** : on se connecte à ce qui a été
   * contrôlé, jamais à un nom qu'on re-résoudrait — c'est ce qui ferme le
   * rebinding DNS, et c'est la même discipline que les sondes.
   */
  async function guard(host: string, port: number): Promise<{ address: string } | { error: string }> {
    try {
      const resolved = await resolveGuarded(host, allowlist);
      return { address: resolved.address };
    } catch (error) {
      const reason =
        error instanceof SsrfBlockedError
          ? error.reason
          : error instanceof Error
            ? error.message
            : String(error);
      refuse(`${host}:${port}`, reason);
      return { error: reason };
    }
  }

  const server = createServer();

  // ── http en clair : le navigateur envoie une requête en forme absolue ──────
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let parsed: URL;
      try {
        parsed = new URL(req.url ?? '');
      } catch {
        res.writeHead(400).end('mandataire : URL absolue attendue');
        return;
      }
      if (parsed.protocol !== 'http:') {
        res.writeHead(400).end('mandataire : http en clair uniquement sur ce chemin');
        return;
      }
      const port = parsed.port === '' ? 80 : Number(parsed.port);
      const verdict = await guard(parsed.hostname, port);
      if ('error' in verdict) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(verdict.error);
        return;
      }

      const headers: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        headers[key] = value;
      }
      // Le `Host` d'origine est conservé alors qu'on se connecte à l'adresse
      // littérale : c'est ce couple qui rend le contrôle utile.
      headers.host = parsed.host;

      const upstream = httpRequest(
        {
          host: verdict.address,
          port,
          method: req.method,
          path: `${parsed.pathname}${parsed.search}`,
          headers,
          setHost: false,
        },
        (upstreamRes) => {
          // Les en-têtes de saut en saut se retirent **aussi** au retour. Les
          // recopier telles quelles laissait le `Connection: keep-alive` de la
          // cible écraser le `Connection: close` demandé par le navigateur, et
          // la socket restait ouverte jusqu'au délai de garde — six secondes de
          // latence sur une réponse déjà complète.
          const headers: Record<string, string | string[]> = {};
          for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (value === undefined) continue;
            if (HOP_BY_HOP.has(key.toLowerCase())) continue;
            headers[key] = value;
          }
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.on('error', (error) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`mandataire : ${error.message}`);
      });
      req.pipe(upstream);
    })();
  });

  // ── https : un tunnel, sans déchiffrement ──────────────────────────────────
  // On ne voit que `host:port`, ce qui suffit à contrôler l'adresse. Ne pas
  // déchiffrer est délibéré : une capture doit voir exactement la même page,
  // avec le même certificat, qu'un visiteur — un mandataire qui s'interpose
  // fausserait le rendu et masquerait justement les pannes de certificat.
  server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    void (async () => {
      const { host, port } = splitAuthority(req.url ?? '', 443);
      const verdict = await guard(host, port);
      if ('error' in verdict) {
        clientSocket.end(`HTTP/1.1 403 Forbidden\r\n\r\n${verdict.error}`);
        return;
      }
      const upstream = netConnect({ host: verdict.address, port }, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      const drop = (): void => {
        upstream.destroy();
        clientSocket.destroy();
      };
      upstream.on('error', drop);
      clientSocket.on('error', drop);
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      server.removeListener('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // Les tunnels ouverts ne se ferment pas tout seuls : sans cela, un
            // arrêt du worker attendrait la fin d'une page qui charge encore.
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
