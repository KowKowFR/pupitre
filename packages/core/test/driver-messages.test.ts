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
 * What the drivers and the SSH layer say follows the instance's language: a
 * deployment's log, a target's preflight, a workload's state. The compiler
 * already guarantees both languages have the same keys; what it does not see
 * are the `{variables}` — a variable forgotten on one side would leave a
 * sentence with a hole in only one of the two languages.
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

describe('Driver and SSH messages — two languages', () => {
  for (const [name, bundle] of Object.entries(bundles)) {
    it(`${name}: the same variables in both languages`, () => {
      const fr = bundle.fr as Record<string, Entry>;
      const en = bundle.en as Record<string, Entry>;
      for (const key of Object.keys(fr)) {
        const english = en[key];
        assert.ok(english !== undefined, `${key} manque en anglais`);
        assert.deepEqual(placeholders(english), placeholders(fr[key] as Entry), key);
      }
    });

    it(`${name}: the English contains no French`, () => {
      for (const [key, value] of Object.entries(bundle.en as Record<string, Entry>)) {
        for (const form of forms(value)) {
          assert.doesNotMatch(form, /[éèêàçùœ«»]/, `${key}: “${form}”`);
        }
      }
    });
  }
});

describe('Driver and SSH messages — rendered in English', () => {
  it('an unresolved secret', () => {
    const error = new UnresolvedSecretError(['JWT_SECRET'], 'en');
    assert.match(error.message, /JWT_SECRET/);
    assert.doesNotMatch(error.message, /[éèàç]/);
    // Without a language, French stays the default value.
    assert.notEqual(new UnresolvedSecretError(['JWT_SECRET']).message, error.message);
  });

  it('a host key that changed', () => {
    const error = new SshHostKeyError('prod-1', 'SHA256:aaa', 'SHA256:bbb', 'en');
    assert.match(error.message, /host key of prod-1 has changed/);
    assert.match(error.message, /SHA256:aaa/);
    assert.match(error.message, /SHA256:bbb/);
  });

  it('a K3s workload’s state', () => {
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
