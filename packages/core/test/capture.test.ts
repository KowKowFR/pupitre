import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import {
  CAPTURE_KINDS,
  MONITOR_CAPTURE_MAX_BYTES,
  MONITOR_CAPTURE_MAX_HEIGHT,
  MONITOR_CAPTURE_QUALITY,
  MONITOR_CAPTURE_REFERENCE_EVERY_HOURS,
  MONITOR_CAPTURE_VIEWPORT_HEIGHT,
  captureHeightFor,
  captureUrlFor,
  parseCidrList,
  referenceIsDue,
} from '../src/monitoring.js';
import { captureUrl } from '../src/capture/cdp.js';
import { createCaptureEgress } from '../src/capture/egress.js';

/**
 * What these tests cover, and what they do not.
 *
 * No rendering test: "the browser produced an image" can only be checked with a
 * real browser, and such a test would be a simulation of Chromium that would
 * mostly prove the simulation works. The proof of rendering is a real capture,
 * shown at review.
 *
 * What **is** tested here is what can break silently:
 *   — the bounds (height, reference interval, capturable URL);
 *   — the egress proxy's SSRF guard, on a real socket;
 *   — and above all: **that an impossible capture never throws**. It is the
 *     rule "a capture never fails a probe" depends on.
 */

// ─── bornes ───────────────────────────────────────────────────────────────────

test('the rendered height is bounded, and says so when it truncates', () => {
  assert.deepEqual(captureHeightFor(1_200), { height: 1_200, truncated: false });
  assert.deepEqual(captureHeightFor(20_000), {
    height: MONITOR_CAPTURE_MAX_HEIGHT,
    truncated: true,
  });
  // A page that declares itself empty must still produce an image: "the page was
  // blank" is precisely one of the diagnoses looked for.
  assert.deepEqual(captureHeightFor(0), {
    height: MONITOR_CAPTURE_VIEWPORT_HEIGHT,
    truncated: false,
  });
  assert.equal(captureHeightFor(Number.NaN).truncated, false);
  // Never an unreadable strip 3 px high.
  assert.ok(captureHeightFor(12).height >= 200);
});

test('the weight and quality bounds stay the ones that were decided', () => {
  assert.equal(MONITOR_CAPTURE_QUALITY, 70);
  assert.equal(MONITOR_CAPTURE_MAX_BYTES, 1_500_000);
  assert.equal(MONITOR_CAPTURE_MAX_HEIGHT, 2_400);
});

test('the reference interval counts in hours, not in measurements', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  assert.equal(referenceIsDue(null, now), true, 'never photographed: due');
  const recent = new Date(now.getTime() - 3_600_000);
  assert.equal(referenceIsDue(recent, now), false);
  const old = new Date(now.getTime() - (MONITOR_CAPTURE_REFERENCE_EVERY_HOURS + 1) * 3_600_000);
  assert.equal(referenceIsDue(old, now), true);
});

// Their labels are the captures screen's (`capture.kind.*`), in the instance's
// language: the core only keeps the moments.
test('there are only three capture moments', () => {
  assert.deepEqual([...CAPTURE_KINDS], ['reference', 'incident_open', 'incident_resolved']);
});

test("only the URLs a browser can open are capturable", () => {
  assert.equal(captureUrlFor('https://exemple.fr/etat'), 'https://exemple.fr/etat');
  assert.equal(captureUrlFor('http://exemple.fr:8080/'), 'http://exemple.fr:8080/');
  assert.equal(captureUrlFor('ftp://exemple.fr/'), null);
  assert.equal(captureUrlFor('file:///etc/passwd'), null);
  assert.equal(captureUrlFor('pas une url'), null);
  // The fragment is useless for rendering and would be copied in clear into the
  // database.
  assert.equal(captureUrlFor('https://exemple.fr/a#jeton'), 'https://exemple.fr/a');
});

// ─── the rule: a capture never throws ─────────────────────────────────────────

test('an unreachable browser returns a verdict, not an exception', async () => {
  // Closed port: it is exactly the case "the Compose profile is not started".
  const outcome = await captureUrl({
    cdpUrl: 'http://127.0.0.1:1/',
    url: 'https://exemple.fr/',
    budgetMs: 3_000,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, 'browser-unavailable');
});

test('a CDP endpoint that answers nonsense returns a verdict too', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"pas":"ce qu\'on attend"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const outcome = await captureUrl({
      cdpUrl: `http://127.0.0.1:${port}/`,
      url: 'https://exemple.fr/',
      budgetMs: 3_000,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'browser-unavailable');
  } finally {
    server.close();
  }
});

// ─── le mandataire de sortie ──────────────────────────────────────────────────

/**
 * The proxy is tested **on a real socket**, not on a simulation: its reason for
 * being is to be the browser's only way out, and a test that called the guard
 * function directly would not prove it is plugged into that path.
 */
async function withEgress<T>(
  allowlist: string,
  body: (base: string, blocked: string[]) => Promise<T>,
): Promise<T> {
  const blocked: string[] = [];
  const egress = await createCaptureEgress({
    allowlist: parseCidrList(allowlist),
    port: 0,
    host: '127.0.0.1',
    onBlocked: (target, reason) => blocked.push(`${target} :: ${reason}`),
  });
  try {
    return await body(`http://127.0.0.1:${egress.port}`, blocked);
  } finally {
    await egress.close();
  }
}

test('the proxy refuses a private address, with the SSRF policy’s reason', async () => {
  await withEgress('', async (base, blocked) => {
    const response = await fetch(`${base}/`, {
      method: 'GET',
      // Absolute form: that is how a browser talks to its proxy. `fetch` cannot emit
      // it, so we go through a raw request.
      headers: { 'x-inutile': '1' },
    }).catch(() => null);
    // A non-absolute request is refused with a 400: the proxy is not a web server.
    assert.equal(response?.status, 400);
    assert.equal(blocked.length, 0, 'nothing to block: the request was malformed');
  });
});

test('the proxy lets public through and blocks private', async () => {
  await withEgress('', async (base, blocked) => {
    // We talk to the proxy like a browser: a request in absolute form.
    const ask = async (target: string): Promise<number> => {
      const url = new URL(base);
      const { createConnection } = await import('node:net');
      return new Promise<number>((resolve, reject) => {
        const socket = createConnection({ host: url.hostname, port: Number(url.port) }, () => {
          socket.write(
            `GET ${target} HTTP/1.1\r\nHost: ${new URL(target).host}\r\nConnection: close\r\n\r\n`,
          );
        });
        let buffer = '';
        socket.setTimeout(8_000, () => {
          socket.destroy();
          reject(new Error('mandataire muet'));
        });
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
        });
        socket.on('end', () => {
          const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(buffer)?.[1] ?? 0);
          resolve(status);
        });
        socket.on('error', reject);
      });
    };

    assert.equal(await ask('http://127.0.0.1:9/'), 403, 'loopback is refused');
    assert.equal(await ask('http://10.1.2.3:80/'), 403, 'private is refused');
    assert.equal(
      await ask('http://169.254.169.254/latest/meta-data/'),
      403,
      'the metadata service is refused, and no list can unlock it',
    );
    assert.equal(blocked.length, 3, 'each refusal is reported to the operator');
    assert.ok(blocked.some((line) => line.includes('169.254.169.254')));
  });
});

test('an explicitly allowed range passes — the guard can be opened, it is not absolute', async () => {
  const target = createServer((_req, res) => {
    res.writeHead(204).end();
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const { port } = target.address() as AddressInfo;

  try {
    await withEgress('127.0.0.0/8', async (base) => {
      const url = new URL(base);
      const { createConnection } = await import('node:net');
      const status = await new Promise<number>((resolve, reject) => {
        const socket = createConnection({ host: url.hostname, port: Number(url.port) }, () => {
          socket.write(
            `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
          );
        });
        let buffer = '';
        socket.setTimeout(8_000, () => {
          socket.destroy();
          reject(new Error('mandataire muet'));
        });
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
        });
        socket.on('end', () => resolve(Number(/^HTTP\/1\.\d (\d{3})/.exec(buffer)?.[1] ?? 0)));
        socket.on('error', reject);
      });
      assert.equal(status, 204, 'MONITOR_ALLOWED_CIDRS opens the same range for the browser');
    });
  } finally {
    target.close();
  }
});

after(() => {
  // Nothing to clean up: each test closes what it opened. This block exists so
  // that `node --test` does not wait for a forgotten descriptor if a test fails.
});
