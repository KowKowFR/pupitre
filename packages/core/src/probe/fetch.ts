import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { TLSSocket } from 'node:tls';
import type { Cidr } from '../monitors/ssrf.js';
import { MONITOR_MAX_REDIRECTS, MONITOR_USER_AGENT } from '../monitors/state.js';
import type { UiLanguage } from '../i18n.js';
import { probeSay } from './messages.js';
import {
  ProbeTimeoutError,
  SsrfBlockedError,
  messageOf,
  resolveUrlGuarded,
  type ResolvedTarget,
} from './net.js';

/**
 * La requête HTTP **gardée** — un seul exemplaire, pour toutes les sondes qui
 * parlent HTTP.
 *
 * ── Pourquoi ce fichier existe ──────────────────────────────────────────────
 * La boucle de redirection est le morceau de code le plus sensible de la
 * supervision : c'est elle qui re-résout et re-contrôle **chaque saut**, donc
 * elle qui ferme le SSRF par redirection. Chaque type de sonde qui parlerait
 * HTTP avec sa propre copie de cette boucle serait une occasion de l'oublier —
 * et la deuxième copie diverge toujours de la première. Elle vit donc ici, une
 * fois, et `http.ts`, `keyword.ts` et le client RDAP de `domain.ts` s'en
 * servent tous les trois.
 *
 * ── Pourquoi pas `fetch` ────────────────────────────────────────────────────
 * Trois exigences que `fetch` ne sait pas tenir :
 *
 *   1. **Se connecter à l'adresse littérale contrôlée**, avec `Host` et SNI du
 *      nom d'origine. C'est ce qui ferme la fenêtre de rebinding DNS entre le
 *      contrôle et la connexion — `fetch` re-résout le nom lui-même.
 *   2. **Suivre les redirections à la main**, pour re-contrôler chaque saut.
 *   3. **Borner la lecture** et couper la socket : `fetch` n'offre pas de
 *      plafond d'octets sans lire le flux entier.
 *
 * Le TTFB vient en prime : on mesure jusqu'aux en-têtes, pas jusqu'à la fin du
 * téléchargement. Ce qu'on veut savoir, c'est la réactivité du service, pas le
 * débit du lien ni le poids de la page.
 *
 * ── La liste d'autorisation est un **paramètre**, pas une constante ──────────
 * `MONITOR_ALLOWED_CIDRS` ouvre des plages internes pour superviser *le parc de
 * l'opérateur*. Une requête vers un tiers que l'opérateur n'a pas choisi — le
 * serveur RDAP d'un registre, désigné par la liste d'amorçage de l'IANA — ne
 * doit **pas** hériter de cette ouverture : sinon un enregistrement DNS
 * empoisonné ferait entrer une requête sortante dans le réseau interne. Ces
 * appels-là passent `allowlist: PUBLIC_ONLY`. Voir `monitors/ssrf.ts`.
 */

/** Aucune plage interne. À passer pour toute requête vers un tiers non choisi. */
export const PUBLIC_ONLY: readonly Cidr[] = [];

export type GuardedFetchInput = {
  url: string;
  method: 'GET' | 'HEAD' | 'POST';
  timeoutMs: number;
  /** Plafond d'octets lus. Au-delà, la socket est coupée et `truncated` est vrai. */
  maxBytes: number;
  /** `false` pour ne pas lire le corps du tout (HEAD, ou rien à y chercher). */
  readBody: boolean;
  allowlist: readonly Cidr[];
  /** La langue du `detail` d'un échec — celle de l'instance. */
  language?: UiLanguage;
  accept?: string;
  maxRedirects?: number;
  /**
   * Interdit `http:` même au départ. Pour les échanges qui n'ont aucune raison
   * d'être en clair — une réponse RDAP altérée en transit dirait n'importe quoi
   * sur l'expiration d'un domaine.
   */
  requireHttps?: boolean;
};

/** Ce qu'on retient du certificat présenté par le dernier saut en https. */
export type PeerCertificateSummary = {
  /** Fin de validité, ISO 8601. */
  validTo: string;
};

export type GuardedFetchSuccess = {
  ok: true;
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
  /** Somme des TTFB de tous les sauts. */
  latencyMs: number;
  redirects: number;
  address: string;
  finalUrl: string;
  /**
   * Le certificat de la page finalement servie — `null` quand elle l'est en
   * clair. Il a déjà été vérifié (`rejectUnauthorized`) : on n'en garde que la
   * date de fin, pour voir venir une expiration avant qu'elle ne coupe le site.
   */
  certificate: PeerCertificateSummary | null;
};

export type GuardedFetchFailure = {
  ok: false;
  /**
   * `blocked` et `network` : rien d'exploitable n'est revenu — c'est
   * `unreachable` côté verdict. `redirect` : la cible a bien répondu, mal — ses
   * redirections sont cassées, c'est `unhealthy`, et `status` est renseigné.
   */
  kind: 'blocked' | 'network' | 'redirect';
  detail: string;
  status: number | null;
  latencyMs: number;
  redirects: number;
  address: string | null;
  finalUrl: string;
};

export type GuardedFetchResult = GuardedFetchSuccess | GuardedFetchFailure;

type HopResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
  headersAtMs: number;
  certificate: PeerCertificateSummary | null;
};

/**
 * Lit le certificat sur la socket de la réponse, tant qu'elle est ouverte.
 * Une date illisible vaut « pas d'information » : la sonde n'invente rien.
 */
function certificateOf(socket: unknown): PeerCertificateSummary | null {
  const tls = socket as Partial<TLSSocket> | null;
  if (!tls || typeof tls.getPeerCertificate !== 'function') return null;
  const validTo = tls.getPeerCertificate(false)?.valid_to;
  if (!validTo) return null;
  const date = new Date(validTo);
  return Number.isNaN(date.getTime()) ? null : { validTo: date.toISOString() };
}

function requestOnce(input: {
  url: URL;
  target: ResolvedTarget;
  method: 'GET' | 'HEAD' | 'POST';
  timeoutMs: number;
  maxBytes: number;
  readBody: boolean;
  accept: string;
}): Promise<HopResponse> {
  const secure = input.url.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;
  const port = input.url.port === '' ? (secure ? 443 : 80) : Number(input.url.port);
  // Horloge monotone : un ajustement NTP pendant la mesure ne doit pas
  // produire une latence négative ou fantaisiste.
  const started = performance.now();

  return new Promise<HopResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const request = send({
      // On se connecte à l'**adresse**, jamais au nom : c'est ce qui ferme la
      // fenêtre entre le contrôle et la connexion. L'en-tête `Host` et le SNI
      // portent le nom, donc le vhost et le certificat sont vérifiés comme il faut.
      host: input.target.address,
      port,
      path: `${input.url.pathname}${input.url.search}`,
      method: input.method,
      servername: secure ? input.target.hostname : undefined,
      rejectUnauthorized: true,
      headers: {
        host: input.url.port === '' ? input.target.hostname : `${input.target.hostname}:${port}`,
        'user-agent': MONITOR_USER_AGENT,
        accept: input.accept,
        // Pas de compression : on lit au plus quelques centaines de kio et on ne
        // veut pas déballer une bombe de décompression pour y chercher un mot-clé.
        'accept-encoding': 'identity',
        connection: 'close',
      },
      timeout: input.timeoutMs,
    });

    request.on('timeout', () => {
      finish(() => {
        request.destroy();
        reject(new ProbeTimeoutError(input.timeoutMs));
      });
    });

    request.on('error', (error) => finish(() => reject(error)));

    request.on('response', (response) => {
      const headersAtMs = Math.round(performance.now() - started);
      const status = response.statusCode ?? 0;
      const headers = response.headers;
      // À lire maintenant : une fois le corps consommé, la socket est fermée.
      const certificate = secure ? certificateOf(response.socket) : null;

      if (!input.readBody) {
        response.resume();
        finish(() =>
          resolve({
            status,
            headers,
            body: Buffer.alloc(0),
            truncated: false,
            headersAtMs,
            certificate,
          }),
        );
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;

      response.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = input.maxBytes - size;
        if (chunk.byteLength >= room) {
          chunks.push(chunk.subarray(0, room));
          truncated = true;
          // On a de quoi chercher le mot-clé : on coupe la socket plutôt que de
          // laisser un flux sans fin nous occuper.
          response.destroy();
          finish(() =>
            resolve({
              status,
              headers,
              body: Buffer.concat(chunks),
              truncated: true,
              headersAtMs,
              certificate,
            }),
          );
          return;
        }
        chunks.push(chunk);
        size += chunk.byteLength;
      });

      response.on('end', () => {
        finish(() =>
          resolve({
            status,
            headers,
            body: Buffer.concat(chunks),
            truncated,
            headersAtMs,
            certificate,
          }),
        );
      });

      response.on('error', (error) => finish(() => reject(error)));
    });

    request.end();
  });
}

const REDIRECT_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Une requête HTTP, redirections comprises, chaque saut re-résolu et
 * re-contrôlé. **Ne lève jamais** : une cible morte est un résultat.
 */
export async function guardedFetch(input: GuardedFetchInput): Promise<GuardedFetchResult> {
  const deadline = Date.now() + input.timeoutMs;
  const maxRedirects = input.maxRedirects ?? MONITOR_MAX_REDIRECTS;
  const accept = input.accept ?? '*/*';
  const language = input.language ?? 'fr';
  const say = probeSay(language);

  let current = input.url;
  let redirects = 0;
  let latencyMs = 0;
  let address: string | null = null;

  const fail = (
    kind: GuardedFetchFailure['kind'],
    detail: string,
    status: number | null,
  ): GuardedFetchFailure => ({
    ok: false,
    kind,
    detail,
    status,
    latencyMs,
    redirects,
    address,
    finalUrl: current,
  });

  for (;;) {
    if (Date.now() >= deadline) {
      return fail('network', say('timeout', { ms: input.timeoutMs }), null);
    }

    let target: ResolvedTarget;
    let parsed: URL;
    try {
      // Chaque saut est re-résolu et re-contrôlé : une URL publique qui redirige
      // vers 169.254.169.254 s'arrête ici.
      const resolved = await resolveUrlGuarded(current, input.allowlist);
      target = resolved.target;
      parsed = resolved.parsed;
      address = target.address;
    } catch (error) {
      const blocked = error instanceof SsrfBlockedError;
      const reason = messageOf(error, language);
      return fail(
        blocked ? 'blocked' : 'network',
        blocked && redirects > 0 ? say('fetch.redirectRefused', { reason }) : reason,
        null,
      );
    }

    if (input.requireHttps === true && parsed.protocol !== 'https:') {
      const reason = say('fetch.notHttps', { url: current });
      return fail(
        'blocked',
        redirects > 0 ? say('fetch.redirectRefused', { reason }) : reason,
        null,
      );
    }

    let hop: HopResponse;
    try {
      hop = await requestOnce({
        url: parsed,
        target,
        method: input.method,
        timeoutMs: Math.max(1, deadline - Date.now()),
        maxBytes: input.maxBytes,
        readBody: input.readBody,
        accept,
      });
    } catch (error) {
      return fail('network', messageOf(error, language), null);
    }

    latencyMs += hop.headersAtMs;
    const location = hop.headers.location;

    if (REDIRECT_CODES.has(hop.status) && typeof location === 'string' && location !== '') {
      if (redirects >= maxRedirects) {
        return fail('redirect', say('fetch.tooManyRedirects', { max: maxRedirects }), hop.status);
      }
      try {
        current = new URL(location, current).toString();
      } catch {
        return fail('redirect', say('fetch.badRedirect', { location }), hop.status);
      }
      redirects += 1;
      continue;
    }

    return {
      ok: true,
      status: hop.status,
      headers: hop.headers,
      body: hop.body,
      truncated: hop.truncated,
      latencyMs,
      redirects,
      address: target.address,
      finalUrl: current,
      certificate: hop.certificate,
    };
  }
}

const MS_PER_DAY = 86_400_000;

/**
 * Les mesures de certificat d'une sonde HTTP : jours restants et date de fin.
 * Vide quand la page est servie en clair. Informatif seulement : c'est la
 * sonde « Certificat TLS » qui porte le préavis et en fait un incident.
 */
export function certificateMetrics(
  certificate: PeerCertificateSummary | null,
  now: number = Date.now(),
): { certDaysRemaining?: number; certValidTo?: string } {
  if (!certificate) return {};
  // Arrondi vers le bas, comme la sonde TLS : « 0 jour » le jour de l'expiration.
  const days = Math.floor((Date.parse(certificate.validTo) - now) / MS_PER_DAY);
  return { certDaysRemaining: days, certValidTo: certificate.validTo };
}

/**
 * Décode un corps de réponse selon le jeu de caractères que le serveur annonce.
 *
 * Supposer UTF-8 partout est une source silencieuse de faux négatifs : un site
 * français encore servi en `windows-1252` rendrait « Connecté » illisible, et
 * la sonde crierait à la panne pour un accent. On lit donc l'étiquette de
 * `content-type` ; si elle est absente ou inconnue de la plateforme, on retombe
 * sur UTF-8 en mode indulgent plutôt que de lever.
 */
export function decodeBody(body: Buffer, contentType: string | undefined): string {
  const label = /charset\s*=\s*"?([\w:.+-]+)"?/i.exec(contentType ?? '')?.[1];
  let text: string;
  try {
    text = new TextDecoder(label ?? 'utf-8').decode(body);
  } catch {
    text = new TextDecoder('utf-8').decode(body);
  }
  // La marque d'ordre des octets n'est pas du contenu ; laissée en tête, elle
  // ferait échouer un mot-clé situé au tout début du document.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
