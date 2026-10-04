import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { domainConfigSchema } from '../src/monitors/catalog.js';
import { describeDnsComparison } from '../src/monitors/dns-records.js';
import { judgeDomain, readRdapDomain } from '../src/probe/domain.js';
import { probeCopy } from '../src/probe/messages.js';
import { messageOf, ProbeTimeoutError } from '../src/probe/net.js';
import { bunkerwebCopy } from '../src/proxy/bunkerweb/messages.js';
import { proxyCopy } from '../src/proxy/messages.js';
import { hostnameProblem } from '../src/proxy/model.js';
import { npmCopy } from '../src/proxy/npm/messages.js';
import { judgeRouteProbe } from '../src/proxy/probe.js';
import { interpretReach } from '../src/proxy/reach.js';
import { interpretTraefikContainer } from '../src/proxy/traefik/detect.js';
import { traefikCopy } from '../src/proxy/traefik/messages.js';

/**
 * Reverse proxies and monitoring probes speak the instance's language: a
 * proxy's "Test", applying domains, testing a link, a reading's `detail` —
 * taken as is by the screen and the alerts. The same check as for the drivers:
 * the same `{variables}` in both languages, no French in the English.
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
  proxy: proxyCopy,
  traefik: traefikCopy,
  bunkerweb: bunkerwebCopy,
  npm: npmCopy,
  probe: probeCopy,
} as const;

describe('Proxy and probe messages — two languages', () => {
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

describe('Proxys — rendus en anglais', () => {
  it('a route probe’s verdict', () => {
    const route = {
      hostname: 'app.example.com',
      tls: true,
      redirectHttps: true,
      waf: 'off' as const,
    };
    const certificate = { status: 'none' as const, subject: null, issuer: null, notAfter: null };
    const broken = judgeRouteProbe(
      route,
      { http: { code: 200, noRoute: false }, https: { code: 502, noRoute: false }, certificate },
      'en',
    );
    assert.equal(
      broken.detail,
      'HTTP: the redirect to HTTPS is missing (200) · HTTPS: the proxy cannot reach the application (502)',
    );
    const fine = judgeRouteProbe(
      route,
      { http: { code: 308, noRoute: false }, https: { code: 200, noRoute: false }, certificate },
      'en',
    );
    assert.equal(fine.detail, 'answers — HTTP 308, HTTPS 200');
  });

  it('testing a link', () => {
    const refused = interpretReach({
      curlCode: 7,
      body: '',
      token: 't',
      address: '10.0.0.5',
      port: 30001,
      proxyName: 'edge',
      language: 'en',
    });
    assert.equal(refused.failure, 'refused');
    assert.match(refused.detail, /^10\.0\.0\.5:30001 refuses the connection from “edge”/);
  });

  it('a refused domain name', () => {
    assert.equal(hostnameProblem('localhost', 'en'), 'at least one dot is required (example.com)');
    assert.equal(hostnameProblem('*.example.com', 'en'), 'wildcards are not supported');
    // Without a language, French stays the default value.
    assert.equal(hostnameProblem('*.example.com'), 'les jokers ne sont pas pris en charge');
  });

  it('a Traefik found in a container', () => {
    const finding = interpretTraefikContainer(
      { Args: ['--entrypoints.web.address=:80', '--providers.file.directory=/dyn'] },
      null,
      'en',
    );
    assert.ok(
      finding.warnings.includes(
        'folder /dyn is not mounted from the machine: Pupitre cannot write to it',
      ),
    );
    assert.ok(finding.warnings.includes('no entry point on port 443: no HTTPS'));
  });
});

describe('Sondes — rendus en anglais', () => {
  const NOW = new Date('2026-09-13T12:00:00Z');

  it('a domain within the notice period, its date unambiguous', () => {
    const facts = readRdapDomain({
      events: [{ eventAction: 'expiration', eventDate: '2026-09-25T00:00:00Z' }],
    });
    const config = domainConfigSchema.parse({ domain: 'example.com', warnDays: 30 });
    const verdict = judgeDomain(facts, config, NOW, 'en');
    assert.equal(verdict.detail, 'expires in 11 days (on 2026-09-25) — within the 30-day warning');
    assert.match(judgeDomain(facts, config, NOW).detail ?? '', /\(le 25\/09\/2026\)/);
  });

  it('a DNS mismatch', () => {
    const detail = describeDnsComparison(
      { ok: false, missing: ['10.0.0.1'], unexpected: ['10.0.0.2', '10.0.0.3'] } as never,
      400,
      'en',
    );
    assert.equal(detail, 'missing: 10.0.0.1 · unexpected: 10.0.0.2, 10.0.0.3');
  });

  it('a timeout, said in the language of whoever reads', () => {
    const error = new ProbeTimeoutError(5000);
    assert.equal(messageOf(error, 'en'), 'timed out after 5000 ms');
    assert.equal(messageOf(error), 'délai dépassé après 5000 ms');
  });
});
