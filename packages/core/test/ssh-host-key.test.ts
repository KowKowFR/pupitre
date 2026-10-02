import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import ssh2 from 'ssh2';
import { connect, disconnect, hostKeyFingerprint } from '../src/ssh/client.js';
import { SshHostKeyError } from '../src/ssh/errors.js';
import type { SshTarget } from '../src/ssh/types.js';

/**
 * La clé d'hôte d'une cible, contre de vrais serveurs SSH lancés ici même :
 * retenue au premier contact, exigée ensuite, et une autre clé refusée sans
 * nouvel essai — sans quoi une machine intercalée sur le réseau recevrait le
 * mot de passe de la cible.
 */

const { Server, utils } = ssh2;

type Running = {
  port: number;
  fingerprint: string;
  handshakes: () => number;
  close: () => Promise<void>;
};

async function startServer(): Promise<Running> {
  const keys = utils.generateKeyPairSync('ed25519');
  const parsed = utils.parseKey(keys.public);
  if (parsed instanceof Error) throw parsed;
  const fingerprint = hostKeyFingerprint(parsed.getPublicSSH());
  let count = 0;
  const server = new Server({ hostKeys: [keys.private] }, (client) => {
    count += 1;
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'pupitre' && ctx.password === 'secret') {
        ctx.accept();
      } else {
        ctx.reject(['password']);
      }
    });
    client.on('ready', () => {});
    client.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    fingerprint,
    handshakes: () => count,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const target = (port: number, hostKey?: SshTarget['hostKey']): SshTarget => ({
  host: '127.0.0.1',
  port,
  username: 'pupitre',
  sudoMethod: 'nopasswd',
  credentials: { authMethod: 'password', password: 'secret' },
  ...(hostKey ? { hostKey } : {}),
});

describe('clé d’hôte d’une cible', () => {
  let machine: Running;
  let impostor: Running;

  before(async () => {
    machine = await startServer();
    impostor = await startServer();
  });
  after(async () => {
    await machine.close();
    await impostor.close();
  });

  it('retient la clé d’une machine jamais jointe', async () => {
    const seen: string[] = [];
    const session = await connect(
      target(machine.port, { expected: null, onFirstSeen: (fp) => void seen.push(fp) }),
    );
    assert.equal(session.hostKey, machine.fingerprint);
    assert.deepEqual(seen, [machine.fingerprint]);
    await disconnect(session);
  });

  it('se connecte quand la clé est celle retenue, sans la retenir de nouveau', async () => {
    let firstSeen = 0;
    const session = await connect(
      target(machine.port, {
        expected: machine.fingerprint,
        onFirstSeen: () => {
          firstSeen += 1;
        },
      }),
    );
    assert.equal(session.hostKey, machine.fingerprint);
    assert.equal(firstSeen, 0);
    await disconnect(session);
  });

  it('refuse une autre clé, le dit, et ne réessaie pas', async () => {
    const mismatches: string[] = [];
    const before = impostor.handshakes();
    await assert.rejects(
      connect(
        target(impostor.port, {
          expected: machine.fingerprint,
          onMismatch: (presented) => void mismatches.push(presented),
        }),
        { retries: 3 },
      ),
      (error: unknown) =>
        error instanceof SshHostKeyError &&
        error.expected === machine.fingerprint &&
        error.presented === impostor.fingerprint &&
        /a changé/.test(error.message),
    );
    assert.deepEqual(mismatches, [impostor.fingerprint]);
    assert.equal(impostor.handshakes() - before, 1, 'une seule tentative');
  });

  it('sans politique — outils de test —, accepte et relève la clé', async () => {
    const session = await connect(target(impostor.port));
    assert.equal(session.hostKey, impostor.fingerprint);
    await disconnect(session);
  });

  it('au format de ssh-keygen -lf : SHA256 en base64, sans « = »', () => {
    assert.match(machine.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});
