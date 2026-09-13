import { parseCidrList, safeParseMonitorConfig, type MonitorType } from '../src/monitoring.js';
import { getMonitorProbe } from '../src/probe/index.js';

/**
 * Harnais des sondes `keyword` et `domain` — **il sonde pour de vrai**.
 *
 *     pnpm --filter @pupitre/core harness:probes
 *
 * Les tests unitaires prouvent la logique sur des fixtures ; ce harnais prouve
 * qu'elle tient face à l'internet tel qu'il est : un vrai site, un vrai
 * registre, une vraie liste d'amorçage. C'est délibérément un script et non un
 * test — un registre indisponible ne doit pas faire rougir une suite.
 *
 * Il est **économe** : deux interrogations RDAP et une lecture de la liste
 * d'amorçage, pas une de plus. Un registre est un service public gratuit.
 */

const ALLOWLIST = parseCidrList(process.env.MONITOR_ALLOWED_CIDRS);

type Scenario = { title: string; expect: string; type: MonitorType; config: Record<string, unknown> };

const SCENARIOS: Scenario[] = [
  {
    title: 'mot-clé présent sur un vrai site',
    expect: 'healthy',
    type: 'keyword',
    config: { url: 'https://example.com/', mustContain: 'Example Domain' },
  },
  {
    title: 'même page, mot-clé absent — la casse et les accents ne sauvent rien',
    expect: 'unhealthy',
    type: 'keyword',
    config: { url: 'https://example.com/', mustContain: 'Se connecter à mon espace' },
  },
  {
    title: 'texte interdit trouvé : la page dit ce qu’elle ne devrait pas dire',
    expect: 'unhealthy',
    type: 'keyword',
    config: { url: 'https://example.com/', mustNotContain: 'Avoid use in operations' },
  },
  {
    title: 'texte interdit, cherché dans le brut : trouvé dans une feuille de style',
    expect: 'unhealthy — faux positif que le mode « texte » évite',
    type: 'keyword',
    config: { url: 'https://example.com/', mustNotContain: 'system-ui', scope: 'raw' },
  },
  {
    title: 'même sonde, balises retirées : le <style> ne compte plus',
    expect: 'healthy',
    type: 'keyword',
    config: { url: 'https://example.com/', mustNotContain: 'system-ui', scope: 'text' },
  },
  {
    title: 'comparaison souple : casse et espaces multiples indifférents',
    expect: 'healthy',
    type: 'keyword',
    config: { url: 'https://example.com/', mustContain: 'EXAMPLE   domain', matching: 'lenient' },
  },
  {
    title: 'RDAP chez Verisign (.com)',
    expect: 'healthy',
    type: 'domain',
    config: { domain: 'example.com', warnDays: 30 },
  },
  {
    title: 'RDAP chez l’AFNIC (.fr), avec vérification du registrar et de la délégation',
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
    title: 'RDAP sur un TLD qui n’en publie pas — refusé avant toute requête',
    expect: 'configuration refusée',
    type: 'domain',
    config: { domain: 'exemple.io' },
  },
];

function show(label: string, value: unknown): void {
  console.log(`    ${label.padEnd(16)} ${value === null || value === undefined ? '—' : String(value)}`);
}

async function main(): Promise<void> {
  console.log(`Harnais des sondes — ${new Date().toISOString()}`);
  console.log(
    `MONITOR_ALLOWED_CIDRS : ${ALLOWLIST.length === 0 ? '(vide — public uniquement)' : ALLOWLIST.map((c) => c.text).join(', ')}\n`,
  );

  for (const scenario of SCENARIOS) {
    console.log(`── ${scenario.title}`);
    console.log(`   type=${scenario.type} attendu=${scenario.expect}`);
    console.log(`   config ${JSON.stringify(scenario.config)}`);

    const parsed = safeParseMonitorConfig(scenario.type, scenario.config);
    if (!parsed.ok) {
      console.log(`   ⛔ configuration refusée : ${parsed.error.issues.map((i) => i.message).join(' ; ')}\n`);
      continue;
    }

    const started = Date.now();
    const result = await getMonitorProbe(scenario.type).run(parsed.config, { allowlist: ALLOWLIST });
    const mark = result.outcome === 'healthy' ? '🟢' : result.outcome === 'unhealthy' ? '🟠' : '🔴';

    console.log(`   ${mark} ${result.outcome}  (${Date.now() - started} ms de bout en bout)`);
    show('latence', result.latencyMs === null ? null : `${result.latencyMs} ms`);
    show('détail', result.detail);
    for (const [key, value] of Object.entries(result.metrics)) show(key, value);
    console.log('');
  }
}

await main();
