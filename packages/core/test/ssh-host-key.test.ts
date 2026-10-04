import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import ssh2 from 'ssh2';
import { connect, disconnect, hostKeyFingerprint } from '../src/ssh/client.js';
import { SshHostKeyError } from '../src/ssh/errors.js';
import type { SshTarget } from '../src/ssh/types.js';

/**
 * A target's host key, against real SSH servers started right here: recorded at
 * first contact, required afterwards, and another key refused without retry —
 * otherwise a machine inserted on the network would receive the target's
 * password.
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

describe('a target’s host key', () => {
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

  it('records the key of a machine never reached', async () => {
    const seen: string[] = [];
    const session = await connect(
      target(machine.port, { expected: null, onFirstSeen: (fp) => void seen.push(fp) }),
    );
    assert.equal(session.hostKey, machine.fingerprint);
    assert.deepEqual(seen, [machine.fingerprint]);
    await disconnect(session);
  });

  it('connects when the key is the recorded one, without recording it again', async () => {
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

  it('refuses another key, says so, and does not retry', async () => {
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
    assert.equal(impostor.handshakes() - before, 1, 'a single attempt');
  });

  it('without a policy — test tools —, accepts and notes the key', async () => {
    const session = await connect(target(impostor.port));
    assert.equal(session.hostKey, impostor.fingerprint);
    await disconnect(session);
  });

  it('in ssh-keygen -lf format: SHA256 in base64, without “=”', () => {
    assert.match(machine.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});
