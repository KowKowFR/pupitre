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
 * Ce que ces tests couvrent, et ce qu'ils ne couvrent pas.
 *
 * Pas de test de rendu : « le navigateur a produit une image » ne se vérifie
 * qu'avec un vrai navigateur, et un tel test serait une simulation de Chromium
 * qui prouverait surtout que la simulation fonctionne. La preuve du rendu est
 * une capture réelle, montrée à la revue.
 *
 * Ce qui **est** testé ici est ce qui peut casser en silence :
 *   — les bornes (hauteur, cadence de référence, URL capturable) ;
 *   — la garde SSRF du mandataire de sortie, sur un vrai socket ;
 *   — et surtout : **qu'une capture impossible ne lève jamais**. C'est la
 *     règle dont dépend « une capture ne fait jamais échouer une sonde ».
 */

// ─── bornes ───────────────────────────────────────────────────────────────────

test('la hauteur rendue est bornée, et le dit quand elle tronque', () => {
  assert.deepEqual(captureHeightFor(1_200), { height: 1_200, truncated: false });
  assert.deepEqual(captureHeightFor(20_000), {
    height: MONITOR_CAPTURE_MAX_HEIGHT,
    truncated: true,
  });
  // Une page qui se déclare vide doit quand même produire une image : « la page
  // était blanche » est précisément l'un des diagnostics recherchés.
  assert.deepEqual(captureHeightFor(0), {
    height: MONITOR_CAPTURE_VIEWPORT_HEIGHT,
    truncated: false,
  });
  assert.equal(captureHeightFor(Number.NaN).truncated, false);
  // Jamais une bande de 3 px de haut, illisible.
  assert.ok(captureHeightFor(12).height >= 200);
});

test('les bornes de poids et de qualité restent celles qui ont été arbitrées', () => {
  assert.equal(MONITOR_CAPTURE_QUALITY, 70);
  assert.equal(MONITOR_CAPTURE_MAX_BYTES, 1_500_000);
  assert.equal(MONITOR_CAPTURE_MAX_HEIGHT, 2_400);
});

test('la cadence de référence se compte en heures, pas en mesures', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  assert.equal(referenceIsDue(null, now), true, 'jamais photographiée : due');
  const recent = new Date(now.getTime() - 3_600_000);
  assert.equal(referenceIsDue(recent, now), false);
  const old = new Date(now.getTime() - (MONITOR_CAPTURE_REFERENCE_EVERY_HOURS + 1) * 3_600_000);
  assert.equal(referenceIsDue(old, now), true);
});

// Leurs libellés sont ceux de l'écran des captures (`capture.kind.*`), dans
// la langue de l'instance : le cœur ne garde que les moments.
test('il n’y a que trois moments de capture', () => {
  assert.deepEqual([...CAPTURE_KINDS], ['reference', 'incident_open', 'incident_resolved']);
});

test("seules les URL qu'un navigateur peut ouvrir sont capturables", () => {
  assert.equal(captureUrlFor('https://exemple.fr/etat'), 'https://exemple.fr/etat');
  assert.equal(captureUrlFor('http://exemple.fr:8080/'), 'http://exemple.fr:8080/');
  assert.equal(captureUrlFor('ftp://exemple.fr/'), null);
  assert.equal(captureUrlFor('file:///etc/passwd'), null);
  assert.equal(captureUrlFor('pas une url'), null);
  // Le fragment ne sert à rien au rendu et se recopierait en clair en base.
  assert.equal(captureUrlFor('https://exemple.fr/a#jeton'), 'https://exemple.fr/a');
});

// ─── la règle : une capture ne lève jamais ────────────────────────────────────

test('un navigateur injoignable rend un verdict, pas une exception', async () => {
  // Port fermé : c'est exactement le cas « le profil Compose n'est pas démarré ».
  const outcome = await captureUrl({
    cdpUrl: 'http://127.0.0.1:1/',
    url: 'https://exemple.fr/',
    budgetMs: 3_000,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, 'browser-unavailable');
});

test('un point CDP qui répond n’importe quoi rend aussi un verdict', async () => {
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
 * Le mandataire est testé **sur un vrai socket**, pas sur une simulation : sa
 * raison d'être est d'être le seul chemin de sortie du navigateur, et un test
 * qui appellerait la fonction de garde directement ne prouverait pas qu'elle
 * est branchée sur ce chemin-là.
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

test('le mandataire refuse une adresse privée, avec le motif de la politique SSRF', async () => {
  await withEgress('', async (base, blocked) => {
    const response = await fetch(`${base}/`, {
      method: 'GET',
      // Forme absolue : c'est ainsi qu'un navigateur parle à son mandataire.
      // `fetch` ne sait pas l'émettre, on passe donc par une requête brute.
      headers: { 'x-inutile': '1' },
    }).catch(() => null);
    // Une requête non absolue est refusée en 400 : le mandataire ne sert pas de
    // serveur web.
    assert.equal(response?.status, 400);
    assert.equal(blocked.length, 0, 'rien à bloquer : la requête était malformée');
  });
});

test('le mandataire laisse passer le public et bloque le privé', async () => {
  await withEgress('', async (base, blocked) => {
    // On parle au mandataire comme un navigateur : requête en forme absolue.
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

    assert.equal(await ask('http://127.0.0.1:9/'), 403, 'le bouclage est refusé');
    assert.equal(await ask('http://10.1.2.3:80/'), 403, 'le privé est refusé');
    assert.equal(
      await ask('http://169.254.169.254/latest/meta-data/'),
      403,
      'le service de métadonnées est refusé, et aucune liste ne peut le débloquer',
    );
    assert.equal(blocked.length, 3, 'chaque refus est signalé à l’exploitant');
    assert.ok(blocked.some((line) => line.includes('169.254.169.254')));
  });
});

test('une plage explicitement autorisée passe — la garde est ouvrable, pas absolue', async () => {
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
      assert.equal(status, 204, 'MONITOR_ALLOWED_CIDRS ouvre la même plage pour le navigateur');
    });
  } finally {
    target.close();
  }
});

after(() => {
  // Rien à nettoyer : chaque test referme ce qu'il a ouvert. Ce bloc existe pour
  // que `node --test` n'attende pas un descripteur oublié si un test échoue.
});
