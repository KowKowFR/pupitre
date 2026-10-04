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
 * The capture browser's driver — in raw CDP, over WebSocket.
 *
 * ── Why not Playwright ──────────────────────────────────────────────────────
 * Playwright would bring richer waits (`networkidle`, selectors) we have no use
 * for here: we load a page and shoot. In exchange it would bring an npm
 * dependency of several megabytes **and** a hard version coupling with the
 * browser image — `playwright.connect()` refuses to talk to a server of another
 * version, which turns any browser update into a synchronized update of two
 * things.
 *
 * The DevTools protocol, on the other hand, has been stable for years on the few
 * commands used here, and Node 24 provides `fetch` and `WebSocket` as globals.
 * The worker therefore gains **no** dependency, and its image does not move by
 * a byte — which was the other half of the problem, the image already weighing
 * 1.88 GB.
 *
 * ── Two details that cost an hour when ignored ──────────────────────────────
 *
 *  1. **The `Host` header.** The DevTools endpoint refuses any request whose
 *     `Host` is neither an IP address nor `localhost` — it is its protection
 *     against DNS rebinding. A `fetch('http://capture-browser:9222')` therefore
 *     gets the door shut in its face. We resolve the name ourselves and talk to
 *     the literal address: the `Host` becomes an IP, and it is accepted.
 *  2. **The announced address.** The browser listens on `127.0.0.1` behind a
 *     relay, and therefore announces a `webSocketDebuggerUrl` on `127.0.0.1` —
 *     unusable from outside. We rewrite the host, we keep the path (it carries
 *     the session identifier).
 *
 * Neither of these two resolutions goes through `resolveGuarded()`, and it is
 * deliberate: it is not a monitored target provided by a user, it is our own
 * container, designated by the deployment configuration. The SSRF guard applies
 * to what the **browser** fetches — see `egress.ts`, which applies it to each
 * request.
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
        if (this.#pending.delete(id)) reject(new Error(`${method} got no answer`));
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
      /* closing an already dead socket teaches nothing */
    }
  }
}

/** The browser's endpoint, resolved and rewritten. */
async function browserEndpoint(cdpUrl: string): Promise<{ ws: string; browser: string }> {
  const configured = new URL(cdpUrl);
  const port = configured.port === '' ? '9222' : configured.port;
  const { address } = await dnsLookup(configured.hostname);
  const authority = `${address.includes(':') ? `[${address}]` : address}:${port}`;

  const response = await fetch(`http://${authority}/json/version`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`/json/version answered ${response.status}`);
  const body = (await response.json()) as { Browser?: string; webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) throw new Error('/json/version without webSocketDebuggerUrl');

  const ws = new URL(body.webSocketDebuggerUrl);
  ws.host = authority;
  return { ws: ws.toString(), browser: body.Browser ?? 'unknown' };
}

function openSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* nothing to do */
      }
      reject(new Error('WebSocket handshake timed out'));
    }, timeoutMs);
    timer.unref?.();
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket connection to the browser refused'));
    });
  });
}

export type CaptureOptions = {
  /** `http://capture-browser:9222`. Absent = capture is off. */
  cdpUrl: string;
  url: string;
  budgetMs?: number;
};

/**
 * Renders a page and produces an image of it. **Never throws.**
 *
 * Everything that can go wrong — browser off, page that does not load, image
 * too heavy — goes out through `CaptureOutcome`'s losing branch. A missing
 * capture is not an incident: the probe has already decided, the alert has
 * already gone out. It is an extra, and an extra that fails keeps quiet.
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
     * A **new browsing context per capture**, thrown away right after.
     *
     * It is the equivalent of a private window: no cookie, local storage or cache
     * shared between two monitored sites. Otherwise a hostile site could set a
     * cookie the next one would send back, and two different customers monitored
     * by the same instance would see each other.
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
    // A monitored page has nothing to download: a download would write into the
    // container and would appear on no image.
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
    // We introduce ourselves. Chromium's default agent is kept — changing it would
    // make sites that negotiate serve another page — but suffixed, so that an
    // operator reading their access logs knows who is passing by.
    await cdp.send(
      'Network.setUserAgentOverride',
      { userAgent: `${navigatorUserAgentOf(endpoint.browser)} Pupitre-Capture/1` },
      sessionId,
    );

    // The main response's code: we listen before navigating, otherwise the event
    // goes by while we wait for `Page.navigate` to return.
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
        // (the latter = the egress proxy refused the address): Chromium's raw reason is
        // more useful than a rewording.
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
      // A single second chance, leaner. Two settings move at once — height and
      // quality — because a page that exceeds 1.5 MB as JPEG 70 is either huge or a
      // full-screen photo, and both can be treated.
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
    // The context is thrown away whatever happens: a forgotten tab keeps the page
    // alive, its timers run, and the browser swells up to its memory limit.
    // Cleanup errors are swallowed — we are not going to fail a successful capture
    // because closing went wrong.
    if (targetId) await cdp.send('Target.closeTarget', { targetId }, undefined, 5_000).catch(noop);
    if (browserContextId) {
      await cdp.send('Target.disposeBrowserContext', { browserContextId }, undefined, 5_000).catch(noop);
    }
    cdp.close();
  }
}

function noop(): void {
  /* best-effort cleanup */
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** The browser's user agent, rebuilt from "Chrome/151.0.…". */
function navigatorUserAgentOf(browser: string): string {
  const version = /[\d.]+/.exec(browser)?.[0] ?? '0.0.0.0';
  return (
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    `Chrome/${version} Safari/537.36`
  );
}

/**
 * Waits for `load`, or returns when the budget is spent.
 *
 * **We shoot even if the page has not finished loading**, and it is the wanted
 * behavior: a page that never finishes is exactly what we want to see. A blank
 * capture "because it was still loading" is information; no capture at all is
 * not.
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

/** Title and final URL. A page that refuses to evaluate keeps the requested URL. */
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
      // Renders beyond the viewport without having to scroll: scrolling would trigger
      // "on scroll" animations and give a half-revealed image.
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: MONITOR_CAPTURE_WIDTH, height, scale: 1 },
      optimizeForSpeed: false,
    },
    sessionId,
    20_000,
  );
  return Uint8Array.from(Buffer.from(shot.data, 'base64'));
}
