import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dockerCopy } from '../src/drivers/docker/messages.js';
import { parseWorkloads } from '../src/drivers/k3s/driver.js';
import { k3sCopy } from '../src/drivers/k3s/messages.js';
import { driverCopy } from '../src/drivers/messages.js';
import { UnresolvedSecretError } from '../src/drivers/secrets.js';
import { SshHostKeyError } from '../src/ssh/errors.js';
import { sshCopy } from '../src/ssh/messages.js';

/**
 * Ce que disent les drivers et la couche SSH suit la langue de l'instance : le
 * journal d'un déploiement, le preflight d'une cible, l'état d'une charge.
 * Le compilateur garantit déjà que les deux langues ont les mêmes clés ; ce
 * qu'il ne voit pas, ce sont les `{variables}` — une variable oubliée d'un
 * côté laisserait une phrase à trou dans une seule des deux langues.
 */

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

const bundles = {
  driver: driverCopy,
  docker: dockerCopy,
  k3s: k3sCopy,
  ssh: sshCopy,
} as const;

describe('Messages des drivers et de SSH — deux langues', () => {
  for (const [name, bundle] of Object.entries(bundles)) {
    it(`${name} : les mêmes variables dans les deux langues`, () => {
      const fr = bundle.fr as Record<string, Entry>;
      const en = bundle.en as Record<string, Entry>;
      for (const key of Object.keys(fr)) {
        const english = en[key];
        assert.ok(english !== undefined, `${key} manque en anglais`);
        assert.deepEqual(placeholders(english), placeholders(fr[key] as Entry), key);
      }
    });

    it(`${name} : l'anglais ne contient pas de français`, () => {
      for (const [key, value] of Object.entries(bundle.en as Record<string, Entry>)) {
        for (const form of forms(value)) {
          assert.doesNotMatch(form, /[éèêàçùœ«»]/, `${key} : « ${form} »`);
        }
      }
    });
  }
});

describe('Messages des drivers et de SSH — rendus en anglais', () => {
  it('un secret non résolu', () => {
    const error = new UnresolvedSecretError(['JWT_SECRET'], 'en');
    assert.match(error.message, /JWT_SECRET/);
    assert.doesNotMatch(error.message, /[éèàç]/);
    // Sans langue, le français reste la valeur par défaut.
    assert.notEqual(new UnresolvedSecretError(['JWT_SECRET']).message, error.message);
  });

  it('une clé d’hôte qui a changé', () => {
    const error = new SshHostKeyError('prod-1', 'SHA256:aaa', 'SHA256:bbb', 'en');
    assert.match(error.message, /host key of prod-1 has changed/);
    assert.match(error.message, /SHA256:aaa/);
    assert.match(error.message, /SHA256:bbb/);
  });

  it('l’état d’une charge K3s', () => {
    const json = JSON.stringify({
      items: [
        {
          kind: 'Deployment',
          metadata: { name: 'api', namespace: 'default' },
          spec: { replicas: 2, template: { spec: { containers: [{ name: 'api', image: 'x' }] } } },
          status: { replicas: 2, readyReplicas: 1 },
        },
        {
          kind: 'Deployment',
          metadata: { name: 'idle', namespace: 'default' },
          spec: { replicas: 0, template: { spec: { containers: [{ name: 'idle', image: 'x' }] } } },
          status: {},
        },
      ],
    });
    const byName = new Map(parseWorkloads(json, 'en').map((workload) => [workload.name, workload]));
    assert.equal(byName.get('api')?.since, '1/2 ready');
    assert.equal(byName.get('idle')?.since, 'scaled to zero');

    const french = new Map(parseWorkloads(json).map((workload) => [workload.name, workload]));
    assert.equal(french.get('api')?.since, '1/2 prêts');
  });
});
