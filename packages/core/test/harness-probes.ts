import { parseCidrList, safeParseMonitorConfig, type MonitorType } from '../src/monitoring.js';
import { getMonitorProbe } from '../src/probe/index.js';

/**
 * Harness for the `keyword` and `domain` probes — **it probes for real**.
 *
 *     pnpm --filter @pupitre/core harness:probes
 *
 * The unit tests prove the logic on fixtures; this harness proves it holds
 * against the Internet as it is: a real site, a real registry, a real bootstrap
 * list. It is deliberately a script and not a test — an unavailable registry
 * must not turn a suite red.
 *
 * It is **frugal**: two RDAP queries and one read of the bootstrap list, not one
 * more. A registry is a free public service.
 */

const ALLOWLIST = parseCidrList(process.env.MONITOR_ALLOWED_CIDRS);

type Scenario = { title: string; expect: string; type: MonitorType; config: Record<string, unknown> };

const SCENARIOS: Scenario[] = [
  {
    title: 'keyword present on a real site',
    expect: 'healthy',
    type: 'keyword',
    config: { url: 'https://example.com/', mustContain: 'Example Domain' },
  },
  {
    title: 'same page, keyword absent — case and accents save nothing',
    expect: 'unhealthy',
    type: 'keyword',
    config: { url: 'https://example.com/', mustContain: 'Se connecter à mon espace' },
  },
  {
    title: 'forbidden text found: the page says what it should not say',
    expect: 'unhealthy',
    type: 'keyword',
    config: { url: 'https://example.com/', mustNotContain: 'Avoid use in operations' },
  },
  {
    title: 'forbidden text, searched in the raw response: found in a style sheet',
    expect: 'unhealthy — a false positive the “text” mode avoids',
    type: 'keyword',
    config: { url: 'https://example.com/', mustNotContain: 'system-ui', scope: 'raw' },
  },
  {
    title: 'same probe, tags removed: the <style> no longer counts',
    expect: 'healthy',
    type: 'keyword',
    config: { url: 'https://example.com/', mustNotContain: 'system-ui', scope: 'text' },
  },
  {
    title: 'lenient comparison: case and multiple spaces irrelevant',
    expect: 'healthy',
    type: 'keyword',
    config: { url: 'https://example.com/', mustContain: 'EXAMPLE   domain', matching: 'lenient' },
  },
  {
    title: 'RDAP at Verisign (.com)',
    expect: 'healthy',
    type: 'domain',
    config: { domain: 'example.com', warnDays: 30 },
  },
  {
    title: 'RDAP at AFNIC (.fr), checking the registrar and the delegation',
    expect: 'healthy',
    type: 'domain',
    config: {
      domain: 'afnic.fr',
      warnDays: 30,
      expectedRegistrar: 'Registry Operations',
      expectedNameserverSuffix: 'nic.fr',
    },
  },
  {
    title: 'RDAP on a TLD that publishes none — refused before any request',
    expect: 'configuration refused',
    type: 'domain',
    config: { domain: 'example.io' },
  },
];

function show(label: string, value: unknown): void {
  console.log(`    ${label.padEnd(16)} ${value === null || value === undefined ? '—' : String(value)}`);
}

async function main(): Promise<void> {
  console.log(`Probe harness — ${new Date().toISOString()}`);
  console.log(
    `MONITOR_ALLOWED_CIDRS: ${ALLOWLIST.length === 0 ? '(empty — public only)' : ALLOWLIST.map((c) => c.text).join(', ')}\n`,
  );

  for (const scenario of SCENARIOS) {
    console.log(`── ${scenario.title}`);
    console.log(`   type=${scenario.type} expected=${scenario.expect}`);
    console.log(`   config ${JSON.stringify(scenario.config)}`);

    const parsed = safeParseMonitorConfig(scenario.type, scenario.config);
    if (!parsed.ok) {
      console.log(`   ⛔ configuration refused: ${parsed.error.issues.map((i) => i.message).join('; ')}\n`);
      continue;
    }

    const started = Date.now();
    const result = await getMonitorProbe(scenario.type).run(parsed.config, {
      language: 'fr',
      allowlist: ALLOWLIST,
    });
    const mark = result.outcome === 'healthy' ? '🟢' : result.outcome === 'unhealthy' ? '🟠' : '🔴';

    console.log(`   ${mark} ${result.outcome}  (${Date.now() - started} ms end to end)`);
    show('latency', result.latencyMs === null ? null : `${result.latencyMs} ms`);
    show('detail', result.detail);
    for (const [key, value] of Object.entries(result.metrics)) show(key, value);
    console.log('');
  }
}

await main();
