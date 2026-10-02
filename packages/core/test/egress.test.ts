import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertEgressAllowed, EgressRefusedError } from '../src/egress.js';

/**
 * Une adresse saisie dans le panel (NPM, webhook, S3) peut être privée — c'est
 * normal —, mais jamais celle des métadonnées d'un cloud.
 */

const resolver = (table: Record<string, string[]>) => async (host: string) => {
  const found = table[host];
  if (!found) throw new Error('ENOTFOUND');
  return found;
};

describe('appels sortants vers une adresse saisie', () => {
  it('refuse les métadonnées d’un cloud, en adresse ou par un nom', async () => {
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

  it('refuse un nom dont une seule des adresses est interdite', async () => {
    await assert.rejects(
      assertEgressAllowed(
        'https://piege.exemple.fr/',
        resolver({ 'piege.exemple.fr': ['203.0.113.7', '169.254.10.1'] }),
      ),
      EgressRefusedError,
    );
  });

  it('laisse passer le réseau privé, la boucle locale et le public', async () => {
    await assertEgressAllowed('http://10.0.0.5:81');
    await assertEgressAllowed('http://192.168.1.20:9000');
    await assertEgressAllowed('http://127.0.0.1:8181');
    await assertEgressAllowed(
      'https://hooks.exemple.fr/x',
      resolver({ 'hooks.exemple.fr': ['203.0.113.7'] }),
    );
  });

  it('laisse passer un nom qui ne se résout pas : l’appel dira lui-même pourquoi', async () => {
    await assertEgressAllowed('https://inconnu.invalid/', resolver({}));
  });
});
