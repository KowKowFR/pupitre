/**
 * Run harness for the `tcp` and `dns` probes, **against real targets**.
 *
 *     pnpm --filter @pupitre/core exec tsx test/probes-live.ts
 *
 * It is not a unit test and it does not run in `pnpm test`: it goes out on the
 * network, so it fails in a train tunnel, and a test that fails for a reason
 * that is not the code is a test one ends up ignoring. It is a harness: you run
 * it, read what it prints, and judge.
 *
 * It checks what no offline test can check: that the probe does talk to real
 * network stacks — a real resolver, a real service announcing a banner, a real
 * closed port — and that the SSRF guard holds against real addresses.
 *
 * The TCP targets are the development stack's containers, reached from the
 * workstation through the ports published on loopback. The harness's allow list
 * therefore opens `127.0.0.0/8` — exactly what `MONITOR_ALLOWED_CIDRS` would do
 * in production for an internal fleet, and the harness shows right after that
 * without that line, everything is refused.
 */
import { parseCidrList, type CheckResult } from '../src/monitoring.js';
import { getMonitorProbe } from '../src/probe/index.js';

const LOOPBACK = parseCidrList('127.0.0.0/8');
const NOTHING = parseCidrList(undefined);

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const OFF = '\u001b[0m';

function badge(result: CheckResult): string {
  if (result.outcome === 'healthy') return `${GREEN}healthy    ${OFF}`;
  if (result.outcome === 'unhealthy') return `${YELLOW}degraded   ${OFF}`;
  return `${RED}unreachable${OFF}`;
}

function show(result: CheckResult): void {
  const metrics = Object.entries(result.metrics)
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('  ');
  console.log(`   ${badge(result)} ${result.detail ?? ''}`);
  if (metrics !== '') console.log(`   ${DIM}${metrics}${OFF}`);
}

async function probe(
  title: string,
  type: 'tcp' | 'dns',
  config: Record<string, unknown>,
  allowlist = LOOPBACK,
): Promise<void> {
  console.log(`\n▸ ${title}`);
  console.log(`   ${DIM}${JSON.stringify(config)}${OFF}`);
  const started = performance.now();
  const result = await getMonitorProbe(type).run(config, { allowlist });
  show(result);
  console.log(`   ${DIM}measured in ${Math.round(performance.now() - started)} ms${OFF}`);
}

function section(title: string): void {
  console.log(`\n\n${'═'.repeat(78)}\n  ${title}\n${'═'.repeat(78)}`);
}

async function main(): Promise<void> {
  section('TCP — the development stack, as it runs');

  await probe('PostgreSQL, port published on loopback', 'tcp', {
    host: '127.0.0.1',
    port: 5433,
  });
  await probe(
    'PostgreSQL with an expected banner — the client speaks first, nothing comes',
    'tcp',
    { host: '127.0.0.1', port: 5433, expectBanner: 'PostgreSQL', timeoutMs: 2_000 },
  );
  await probe('Redis, port published on loopback', 'tcp', { host: '127.0.0.1', port: 6380 });
  await probe('The SSH test target — a service that does announce itself', 'tcp', {
    host: '127.0.0.1',
    port: 2222,
    expectBanner: 'SSH-2.0',
  });
  await probe('The same, with the wrong expected banner', 'tcp', {
    host: '127.0.0.1',
    port: 2222,
    expectBanner: '220 ESMTP',
  });
  await probe('A closed port', 'tcp', { host: '127.0.0.1', port: 9 });
  await probe('A public address that filters — the timeout, not the refusal', 'tcp', {
    host: 'example.com',
    port: 9,
    timeoutMs: 3_000,
  }, NOTHING);
  await probe('A public port that answers', 'tcp', { host: 'example.com', port: 443 }, NOTHING);

  section('TCP — the SSRF guard, on real addresses');

  await probe(
    'A cloud’s metadata service — refused whatever the list',
    'tcp',
    { host: '169.254.169.254', port: 80 },
    parseCidrList('0.0.0.0/0'),
  );
  await probe(
    'The same PostgreSQL, but without MONITOR_ALLOWED_CIDRS',
    'tcp',
    { host: '127.0.0.1', port: 5433 },
    NOTHING,
  );
  await probe('A private range not listed', 'tcp', { host: '10.0.0.5', port: 22 }, NOTHING);
  await probe('“localhost”, refused by its name', 'tcp', { host: 'localhost', port: 5433 });

  section('DNS — stable public names');

  await probe('Presence: does example.com’s A exist', 'dns', {
    name: 'example.com',
    recordType: 'A',
  });
  await probe('The NS of root-servers.net — the most stable delegation in the world', 'dns', {
    name: 'iana.org',
    recordType: 'NS',
  });
  await probe('gmail.com’s MX, compared out of order', 'dns', {
    name: 'gmail.com',
    recordType: 'MX',
    expected:
      '40 alt4.gmail-smtp-in.l.google.com, 5 gmail-smtp-in.l.google.com, 30 alt3.gmail-smtp-in.l.google.com, 10 alt1.gmail-smtp-in.l.google.com, 20 alt2.gmail-smtp-in.l.google.com',
  });
  await probe('google.com’s SPF, “at least these values” regime', 'dns', {
    name: 'google.com',
    recordType: 'TXT',
    expected: 'v=spf1 include:_spf.google.com ~all',
    match: 'contains',
  });
  await probe('The same SPF in the “exactly” regime — every other TXT is extra', 'dns', {
    name: 'google.com',
    recordType: 'TXT',
    expected: 'v=spf1 include:_spf.google.com ~all',
    match: 'exact',
  });
  await probe('google.com’s CAA, with the expected value', 'dns', {
    name: 'google.com',
    recordType: 'CAA',
    expected: '0 ISSUE PKI.goog',
  });
  await probe('An AAAA written in another form than the resolver’s', 'dns', {
    name: 'one.one.one.one',
    recordType: 'AAAA',
    expected: '2606:4700:4700:0000:0000:0000:0000:1111, 2606:4700:4700::1001',
  });
  await probe('A wrong expected value — what the operator sees in the alert', 'dns', {
    name: 'example.com',
    recordType: 'A',
    expected: '203.0.113.7',
  });
  await probe('A name that does not exist (guaranteed NXDOMAIN, reserved TLD)', 'dns', {
    name: 'this-really-does-not-exist.invalid',
    recordType: 'A',
  });
  await probe('A nonexistent subdomain under a domain that exists', 'dns', {
    name: 'this-really-does-not-exist.example.com',
    recordType: 'A',
  });
  await probe('A name that exists without a record of the requested type', 'dns', {
    name: 'example.com',
    recordType: 'SRV',
  });

  section('DNS — the resolver, the only endpoint the guard checks');

  await probe('System resolver (the container’s, or the workstation’s)', 'dns', {
    name: 'example.com',
    recordType: 'A',
  });
  await probe('Declared public resolver — what the world sees, without the local cache', 'dns', {
    name: 'example.com',
    recordType: 'A',
    resolver: '1.1.1.1',
  });
  await probe(
    'An internal resolver not listed — refused before the slightest query',
    'dns',
    { name: 'example.com', recordType: 'A', resolver: '10.0.0.53' },
    NOTHING,
  );

  console.log('');
}

await main();
