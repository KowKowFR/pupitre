import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, it } from 'node:test';
import { backupCopy } from '../src/backup/messages.js';
import { createDecryptStream, encryptBuffer } from '../src/backup/format.js';
import { LocalBackupStore } from '../src/backup/stores/local.js';
import { EgressRefusedError, assertEgressAllowed } from '../src/egress.js';
import { createMaintenanceSchema } from '../src/maintenance.js';
import { redactSecrets } from '../src/notifications/types.js';
import { scannerCopy } from '../src/scanners/messages.js';
import { issueMessage } from '../src/validation.js';

/**
 * Les messages des opérations — sauvegardes, scanners, sortie réseau,
 * masquage des secrets, fenêtres de maintenance — dans les deux langues.
 */

const MASTER_KEY = 'a'.repeat(64);

type Entry = string | Readonly<Record<string, string>>;

function forms(value: Entry): string[] {
  return typeof value === 'string' ? [value] : Object.values(value);
}

function placeholders(value: Entry): string[] {
  const names = new Set<string>();
  for (const form of forms(value)) {
    for (const match of form.matchAll(/\{(\w+)\}/g)) names.add(match[1] ?? '');
  }
  return [...names].sort();
}

describe('Messages des opérations — deux langues', () => {
  for (const [name, bundle] of Object.entries({ backup: backupCopy, scanner: scannerCopy })) {
    it(`${name} : mêmes variables, pas de français dans l'anglais`, () => {
      const fr = bundle.fr as Record<string, Entry>;
      const en = bundle.en as Record<string, Entry>;
      for (const key of Object.keys(fr)) {
        assert.ok(en[key] !== undefined, `${key} manque en anglais`);
        assert.deepEqual(placeholders(en[key] as Entry), placeholders(fr[key] as Entry), key);
        for (const form of forms(en[key] as Entry)) {
          assert.doesNotMatch(form, /[éèêàçùœ«»]/, `${key} : « ${form} »`);
        }
      }
    });
  }
});

describe('Messages des opérations — rendus en anglais', () => {
  it('une destination de sauvegarde absente', async () => {
    const store = new LocalBackupStore({ path: '/pupitre-test-absent' }, 'en');
    await assert.rejects(store.check(), /does not exist in the worker container/);
  });

  it('un fichier de sauvegarde tronqué', async () => {
    const sealed = await encryptBuffer(Buffer.from('pupitre'), MASTER_KEY);
    const truncated = sealed.subarray(0, sealed.length - 4);
    await assert.rejects(
      pipeline(
        Readable.from([truncated]),
        createDecryptStream(MASTER_KEY, 'en'),
        async function* (source) {
          for await (const _chunk of source) yield _chunk;
        },
      ),
      /authentication failed|truncated backup file/,
    );
  });

  it('une sortie réseau refusée', async () => {
    const refused = await assertEgressAllowed('http://169.254.169.254/latest').then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(refused instanceof EgressRefusedError);
    assert.match(refused.describe('en'), /link-local address .* refused/);
    assert.match(refused.message, /lien-local/);
  });

  it('un secret masqué', () => {
    assert.equal(
      redactSecrets('token abcdefghijkl refused', { token: 'abcdefghijkl' }, 'en'),
      'token [redacted secret] refused',
    );
  });

  it('une fenêtre de maintenance mal formée', () => {
    const parsed = createMaintenanceSchema.safeParse({
      title: 'Migration',
      startsAt: '2026-10-05T10:00:00Z',
      endsAt: '2026-10-05T09:00:00Z',
    });
    assert.ok(!parsed.success);
    const messages = parsed.error.issues.map((issue) => issueMessage(issue, 'en'));
    assert.ok(messages.includes('the end must come after the start'), messages.join(' | '));
    assert.ok(messages.includes('a window covers at least one target or probe'));
  });
});
