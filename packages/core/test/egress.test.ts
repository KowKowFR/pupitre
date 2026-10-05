import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertEgressAllowed, EgressRefusedError } from '../src/egress.js';

/**
 * An address entered in the panel (NPM, webhook, S3) can be private — that is
 * normal —, but never a cloud's metadata address.
 */

const resolver = (table: Record<string, string[]>) => async (host: string) => {
  const found = table[host];
  if (!found) throw new Error('ENOTFOUND');
  return found;
};

describe('outgoing calls to a typed-in address', () => {
  it('refuses a cloud’s metadata, by address or by name', async () => {
    await assert.rejects(
      assertEgressAllowed('http://169.254.169.254/latest/meta-data/'),
      (error: unknown) => error instanceof EgressRefusedError && /lien-local/.test(error.message),
    );
    await assert.rejects(
      assertEgressAllowed(
        'http://metadata.google.internal/computeMetadata/v1/',
        resolver({ 'metadata.google.internal': ['169.254.169.254'] }),
      ),
      EgressRefusedError,
    );
    await assert.rejects(assertEgressAllowed('http://[fe80::1]:81/'), EgressRefusedError);
  });

  it('refuses a name only one of whose addresses is forbidden', async () => {
    await assert.rejects(
      assertEgressAllowed(
        'https://piege.exemple.fr/',
        resolver({ 'piege.exemple.fr': ['203.0.113.7', '169.254.10.1'] }),
      ),
      EgressRefusedError,
    );
  });

  it('lets the private network, loopback and public through', async () => {
    await assertEgressAllowed('http://10.0.0.5:81');
    await assertEgressAllowed('http://192.168.1.20:9000');
    await assertEgressAllowed('http://127.0.0.1:8181');
    await assertEgressAllowed(
      'https://hooks.exemple.fr/x',
      resolver({ 'hooks.exemple.fr': ['203.0.113.7'] }),
    );
  });

  it('lets through a name that does not resolve: the call will say why itself', async () => {
    await assertEgressAllowed('https://inconnu.invalid/', resolver({}));
  });
});
