import { lookup as dnsLookup } from 'node:dns/promises';
import {
  MONITOR_CAPTURE_BUDGET_MS,
  MONITOR_CAPTURE_FALLBACK_HEIGHT,
  MONITOR_CAPTURE_FALLBACK_QUALITY,
  MONITOR_CAPTURE_FORMAT,
  MONITOR_CAPTURE_LOAD_TIMEOUT_MS,
  MONITOR_CAPTURE_MAX_BYTES,
  MONITOR_CAPTURE_MAX_HEIGHT,
  MONITOR_CAPTURE_QUALITY,
  MONITOR_CAPTURE_SETTLE_MS,
  MONITOR_CAPTURE_VIEWPORT_HEIGHT,
  MONITOR_CAPTURE_WIDTH,
  captureHeightFor,
  type CaptureOutcome,
} from '../monitors/capture.js';

/**
 * Le pilote du navigateur de capture — en CDP brut, par WebSocket.
 *
 * ── Pourquoi pas Playwright ─────────────────────────────────────────────────
 * Playwright apporterait des attentes plus riches (`networkidle`, sélecteurs)
 * dont on n'a pas l'usage ici : on charge une page et on tire. En échange il
 * apporterait une dépendance npm de plusieurs mégaoctets **et** un couplage de
 * version dur avec l'image du navigateur — `playwright.connect()` refuse de
 * parler à un serveur d'une autre version, ce qui transforme toute mise à jour
 * du navigateur en mise à jour synchronisée de deux choses.
 *
 * Le protocole DevTools, lui, est stable depuis des années sur les quelques
 * commandes utilisées ici, et Node 24 fournit `fetch` et `WebSocket` en global.
 * Le worker ne gagne donc **aucune** dépendance, et son image ne bouge pas d'un
 * octet — ce qui était l'autre moitié du problème, l'image faisant déjà 1,88 Go.
 *
 * ── Deux détails qui font perdre une heure quand on les ignore ──────────────
 *
 *  1. **L'en-tête `Host`.** Le point d'entrée DevTools refuse toute requête
 *     dont le `Host` n'est ni une adresse IP ni `localhost` — c'est sa
 *     protection contre le rebinding DNS. Un `fetch('http://capture-browser:9222')`
 *     se fait donc fermer au nez. On résout le nom nous-mêmes et on parle à
 *     l'adresse littérale : le `Host` devient une IP, et c'est accepté.
 *  2. **L'adresse annoncée.** Le navigateur écoute sur `127.0.0.1` derrière un
 *     relais, et annonce donc une `webSocketDebuggerUrl` en `127.0.0.1` —
 *     inutilisable depuis l'extérieur. On réécrit l'hôte, on garde le chemin
 *     (il porte l'identifiant de session).
 *
 * Aucune de ces deux résolutions ne passe par `resolveGuarded()`, et c'est
 * volontaire : ce n'est pas une cible supervisée fournie par un utilisateur,
 * c'est notre propre conteneur, désigné par la configuration de déploiement. La
 * garde SSRF s'applique à ce que le **navigateur** va chercher — voir
 * `egress.ts`, qui la lui applique sur chaque requête.
 */

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  sessionId?: string;
};

class CdpConnection {
  #socket: WebSocket;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  #listeners = new Set<(message: CdpMessage) => void>();
  #closed: Error | null = null;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event: MessageEvent) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(String(event.data)) as CdpMessage;
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const entry = this.#pending.get(message.id);
        if (!entry) return;
        this.#pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve((message.result ?? {}) as never);
        return;
      }
      for (const listener of [...this.#listeners]) listener(message);
    });
    const fail = (reason: string) => {
      this.#closed = new Error(reason);
      for (const [, entry] of this.#pending) entry.reject(this.#closed);
      this.#pending.clear();
    };
    socket.addEventListener('close', () => fail('connexion au navigateur fermée'));
    socket.addEventListener('error', () => fail('connexion au navigateur en erreur'));
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 15_000,
  ): Promise<T> {
    if (this.#closed) throw this.#closed;
    const id = this.#nextId++;
    const payload: CdpMessage = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.#socket.send(JSON.stringify(payload));
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: resolve as (v: never) => void,
        reject,
      });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} sans réponse`));
      }, timeoutMs).unref?.();
    });
  }

  on(listener: (message: CdpMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    try {
      this.#socket.close();
    } catch {
      /* la fermeture d'une socket déjà morte n'apprend rien */
    }
  }
}

/** Le point d'entrée du navigateur, résolu et réécrit. */
async function browserEndpoint(cdpUrl: string): Promise<{ ws: string; browser: string }> {
  const configured = new URL(cdpUrl);
  const port = configured.port === '' ? '9222' : configured.port;
  const { address } = await dnsLookup(configured.hostname);
  const authority = `${address.includes(':') ? `[${address}]` : address}:${port}`;

  const response = await fetch(`http://${authority}/json/version`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`/json/version a répondu ${response.status}`);
  const body = (await response.json()) as { Browser?: string; webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) throw new Error('/json/version sans webSocketDebuggerUrl');

  const ws = new URL(body.webSocketDebuggerUrl);
  ws.host = authority;
  return { ws: ws.toString(), browser: body.Browser ?? 'inconnu' };
}

function openSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* rien à faire */
      }
      reject(new Error('poignée de main WebSocket expirée'));
    }, timeoutMs);
    timer.unref?.();
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('connexion WebSocket au navigateur refusée'));
    });
  });
}

export type CaptureOptions = {
  /** `http://capture-browser:9222`. Absent = la capture est éteinte. */
  cdpUrl: string;
  url: string;
  budgetMs?: number;
};

/**
 * Rend une page et en produit une image. **Ne lève jamais.**
 *
 * Tout ce qui peut mal tourner — navigateur éteint, page qui ne charge pas,
 * image trop lourde — sort par la branche perdante de `CaptureOutcome`. Une
 * capture manquante n'est pas un incident : la sonde a déjà tranché, l'alerte
 * est déjà partie. C'est un supplément, et un supplément qui échoue se tait.
 */
export async function captureUrl(options: CaptureOptions): Promise<CaptureOutcome> {
  const budgetMs = options.budgetMs ?? MONITOR_CAPTURE_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const started = Date.now();

  let endpoint: { ws: string; browser: string };
  try {
    endpoint = await browserEndpoint(options.cdpUrl);
  } catch (error) {
    return {
      ok: false,
      reason: 'browser-unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  let socket: WebSocket;
  try {
    socket = await openSocket(endpoint.ws, Math.max(1_000, deadline - Date.now()));
  } catch (error) {
    return {
      ok: false,
      reason: 'browser-unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const cdp = new CdpConnection(socket);
  let browserContextId: string | null = null;
  let targetId: string | null = null;

  try {
    /**
     * Un **contexte de navigation neuf par capture**, jeté aussitôt après.
     *
     * C'est l'équivalent d'une fenêtre privée : ni cookie, ni stockage local,
     * ni cache partagés entre deux sites supervisés. Sans quoi un site hostile
     * pourrait poser un cookie que le suivant renverrait, et deux clients
     * différents supervisés par la même instance se verraient l'un l'autre.
     */
    ({ browserContextId } = await cdp.send<{ browserContextId: string }>(
      'Target.createBrowserContext',
      { disposeOnDetach: true },
    ));
    ({ targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
      width: MONITOR_CAPTURE_WIDTH,
      height: MONITOR_CAPTURE_VIEWPORT_HEIGHT,
    }));
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    // Une page supervisée n'a rien à télécharger : un téléchargement écrirait
    // dans le conteneur et n'apparaîtrait sur aucune image.
    await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' }, sessionId);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: MONITOR_CAPTURE_WIDTH,
        height: MONITOR_CAPTURE_VIEWPORT_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      },
      sessionId,
    );
    // On se présente. L'agent par défaut de Chromium est conservé — le changer
    // ferait servir une autre page par les sites qui négocient — mais suffixé,
    // pour qu'un exploitant qui lit ses journaux d'accès sache qui passe.
    await cdp.send(
      'Network.setUserAgentOverride',
      { userAgent: `${navigatorUserAgentOf(endpoint.browser)} Pupitre-Capture/1` },
      sessionId,
    );

    // Le code de la réponse principale : on écoute avant de naviguer, sinon
    // l'événement passe pendant qu'on attend le retour de `Page.navigate`.
    const documents: Array<{ frameId: string; status: number }> = [];
    const offResponse = cdp.on((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method !== 'Network.responseReceived') return;
      const params = message.params as
        | { type?: string; frameId?: string; response?: { status?: number } }
        | undefined;
      if (params?.type !== 'Document') return;
      if (typeof params.frameId !== 'string' || typeof params.response?.status !== 'number') return;
      documents.push({ frameId: params.frameId, status: params.response.status });
    });

    const navigation = await cdp.send<{ frameId: string; errorText?: string }>(
      'Page.navigate',
      { url: options.url },
      sessionId,
      Math.max(1_000, deadline - Date.now()),
    );
    if (navigation.errorText) {
      offResponse();
      return {
        ok: false,
        reason: 'navigation-failed',
        // `ERR_NAME_NOT_RESOLVED`, `ERR_CONNECTION_REFUSED`, `ERR_TUNNEL_CONNECTION_FAILED`
        // (celui-ci = le mandataire de sortie a refusé l'adresse) : le motif
        // brut de Chromium est plus utile qu'une reformulation.
        detail: navigation.errorText,
      };
    }

    await waitForLoad(cdp, sessionId, Math.min(MONITOR_CAPTURE_LOAD_TIMEOUT_MS, deadline - Date.now()));
    await sleep(MONITOR_CAPTURE_SETTLE_MS);
    offResponse();

    const mainDocument = [...documents].reverse().find((doc) => doc.frameId === navigation.frameId);
    const httpStatus = mainDocument?.status ?? documents.at(-1)?.status ?? null;

    const page = await readPageIdentity(cdp, sessionId, options.url);
    const layout = await cdp.send<{ cssContentSize?: { height?: number } }>(
      'Page.getLayoutMetrics',
      {},
      sessionId,
    );

    const first = captureHeightFor(layout.cssContentSize?.height ?? 0, MONITOR_CAPTURE_MAX_HEIGHT);
    let data = await shoot(cdp, sessionId, first.height, MONITOR_CAPTURE_QUALITY);
    let height = first.height;
    let truncated = first.truncated;

    if (data.byteLength > MONITOR_CAPTURE_MAX_BYTES) {
      // Une seule seconde chance, plus économe. Deux réglages bougent d'un coup
      // — hauteur et qualité — parce qu'une page qui dépasse 1,5 Mo en JPEG 70
      // est soit immense, soit une photo plein écran, et les deux se soignent.
      const second = captureHeightFor(first.height, MONITOR_CAPTURE_FALLBACK_HEIGHT);
      data = await shoot(cdp, sessionId, second.height, MONITOR_CAPTURE_FALLBACK_QUALITY);
      height = second.height;
      truncated = truncated || second.truncated;
    }

    if (data.byteLength > MONITOR_CAPTURE_MAX_BYTES) {
      return {
        ok: false,
        reason: 'too-large',
        detail: `${Math.round(data.byteLength / 1024)} Ko après réduction, borne à ${Math.round(
          MONITOR_CAPTURE_MAX_BYTES / 1024,
        )} Ko`,
      };
    }

    return {
      ok: true,
      image: {
        data,
        format: MONITOR_CAPTURE_FORMAT,
        width: MONITOR_CAPTURE_WIDTH,
        height,
        truncated,
        finalUrl: page.url,
        httpStatus,
        pageTitle: page.title,
        elapsedMs: Date.now() - started,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = Date.now() >= deadline || /sans réponse|expir/i.test(message);
    return { ok: false, reason: timedOut ? 'timeout' : 'navigation-failed', detail: message };
  } finally {
    // Le contexte est jeté quoi qu'il arrive : un onglet oublié garde la page
    // vivante, ses minuteurs tournent, et le navigateur enfle jusqu'à sa borne
    // mémoire. Les erreurs de nettoyage sont avalées — on ne va pas faire
    // échouer une capture réussie parce que la fermeture a raté.
    if (targetId) await cdp.send('Target.closeTarget', { targetId }, undefined, 5_000).catch(noop);
    if (browserContextId) {
      await cdp.send('Target.disposeBrowserContext', { browserContextId }, undefined, 5_000).catch(noop);
    }
    cdp.close();
  }
}

function noop(): void {
  /* nettoyage au mieux */
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** L'agent utilisateur du navigateur, reconstitué depuis « Chrome/151.0.… ». */
function navigatorUserAgentOf(browser: string): string {
  const version = /[\d.]+/.exec(browser)?.[0] ?? '0.0.0.0';
  return (
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    `Chrome/${version} Safari/537.36`
  );
}

/**
 * Attend `load`, ou rend la main quand le budget est épuisé.
 *
 * **On tire même si la page n'a pas fini de charger**, et c'est le comportement
 * voulu : une page qui ne finit jamais est exactement ce qu'on veut voir. Une
 * capture blanche « parce que ça chargeait encore » est une information ; pas
 * de capture du tout n'en est pas une.
 */
async function waitForLoad(
  cdp: CdpConnection,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  if (timeoutMs <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve();
    }, timeoutMs);
    timer.unref?.();
    const off = cdp.on((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method !== 'Page.loadEventFired') return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

/** Titre et URL finale. Une page qui refuse d'évaluer garde l'URL demandée. */
async function readPageIdentity(
  cdp: CdpConnection,
  sessionId: string,
  fallbackUrl: string,
): Promise<{ title: string | null; url: string }> {
  try {
    const evaluated = await cdp.send<{ result?: { value?: string } }>(
      'Runtime.evaluate',
      {
        expression: 'JSON.stringify({t: document.title, u: location.href})',
        returnByValue: true,
      },
      sessionId,
      5_000,
    );
    const raw = evaluated.result?.value;
    if (typeof raw !== 'string') return { title: null, url: fallbackUrl };
    const parsed = JSON.parse(raw) as { t?: unknown; u?: unknown };
    const title = typeof parsed.t === 'string' && parsed.t !== '' ? parsed.t.slice(0, 300) : null;
    const url = typeof parsed.u === 'string' ? parsed.u.slice(0, 2048) : fallbackUrl;
    return { title, url };
  } catch {
    return { title: null, url: fallbackUrl };
  }
}

async function shoot(
  cdp: CdpConnection,
  sessionId: string,
  height: number,
  quality: number,
): Promise<Uint8Array> {
  const shot = await cdp.send<{ data: string }>(
    'Page.captureScreenshot',
    {
      format: MONITOR_CAPTURE_FORMAT,
      quality,
      // Rend au-delà de la fenêtre sans avoir à faire défiler : un défilement
      // déclencherait les animations « au scroll » et donnerait une image à
      // moitié apparue.
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: MONITOR_CAPTURE_WIDTH, height, scale: 1 },
      optimizeForSpeed: false,
    },
    sessionId,
    20_000,
  );
  return Uint8Array.from(Buffer.from(shot.data, 'base64'));
}
