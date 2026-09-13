import { Resolver } from 'node:dns/promises';
import { dnsConfigSchema, type DnsConfig } from '../monitors/catalog.js';
import {
  compareDnsRecords,
  describeDnsComparison,
  normalizeDnsName,
  parseExpectedRecords,
  type DnsRecordType,
} from '../monitors/dns-records.js';
import { checkAddress, type Cidr } from '../monitors/ssrf.js';
import type { CheckResult } from '../monitors/state.js';
import { messageOf } from './net.js';
import type { MonitorProbe, ProbeContext } from './types.js';

/**
 * Sonde d'enregistrements DNS.
 *
 * ── Ce que la garde SSRF veut dire ici, et c'est le point subtil ────────────
 * Les autres sondes se connectent à ce qu'elles surveillent ; celle-ci **non**.
 * Elle pose une question *à propos* d'un nom, à un résolveur. Les adresses
 * qu'elle obtient sont des **données** : on les compare, on ne les joint jamais.
 * Les soumettre au contrôle d'adresse serait absurde — superviser « le A de
 * `db.interne` vaut bien 10.0.0.5 » est parfaitement légitime, et ne joint rien.
 *
 * La règle qui couvre tous les types sans cas particulier est donc : **la garde
 * porte sur tout endpoint vers lequel le worker ouvre une socket**. Ici, cet
 * endpoint est le résolveur, et c'est lui qui est contrôlé — avec une exception
 * explicite pour le résolveur du système, qui n'est pas une saisie d'utilisateur
 * mais un fait de déploiement (dans un conteneur, c'est souvent `127.0.0.11`,
 * que la garde refuserait à tort).
 *
 * ── Pourquoi `Resolver` et pas `dns.resolve` ────────────────────────────────
 * Une instance de `Resolver` porte ses propres serveurs et son propre délai.
 * Les fonctions du module global partagent une configuration de processus : les
 * faire pointer sur le résolveur d'une sonde changerait la résolution de **tout
 * le worker**, déploiements SSH compris. Une instance par mesure, jetée après,
 * est la seule forme correcte.
 *
 * `Resolver` fait aussi ce qu'il faut d'autre : il interroge le type demandé
 * (`resolveMx`, `resolveCaa`…) au lieu de passer par `getaddrinfo`, il ne suit
 * pas le suffixe de recherche du système, et il rend les enregistrements
 * structurés plutôt que du texte à réanalyser.
 */

/** Une réponse, réduite à des chaînes affichables — la comparaison fait le reste. */
type Answer = { values: string[]; minTtl: number | null };

async function query(
  resolver: Resolver,
  name: string,
  type: DnsRecordType,
): Promise<Answer> {
  switch (type) {
    case 'A': {
      // `ttl: true` : le TTL n'est pas du signal de panne, mais il explique
      // pourquoi une correction met du temps à se voir. C'est la question
      // qu'on se pose toujours en incident.
      const records = await resolver.resolve4(name, { ttl: true });
      return {
        values: records.map((record) => record.address),
        minTtl: records.length === 0 ? null : Math.min(...records.map((r) => r.ttl)),
      };
    }
    case 'AAAA': {
      const records = await resolver.resolve6(name, { ttl: true });
      return {
        values: records.map((record) => record.address),
        minTtl: records.length === 0 ? null : Math.min(...records.map((r) => r.ttl)),
      };
    }
    case 'CNAME':
      return { values: await resolver.resolveCname(name), minTtl: null };
    case 'NS':
      return { values: await resolver.resolveNs(name), minTtl: null };
    case 'MX': {
      const records = await resolver.resolveMx(name);
      return {
        values: records.map((record) => `${record.priority} ${record.exchange}`),
        minTtl: null,
      };
    }
    case 'SRV': {
      const records = await resolver.resolveSrv(name);
      return {
        values: records.map(
          (record) => `${record.priority} ${record.weight} ${record.port} ${record.name}`,
        ),
        minTtl: null,
      };
    }
    case 'CAA': {
      const records = await resolver.resolveCaa(name);
      return {
        values: records.map((record) => {
          // Node rend `{ critical, type: 'CAA', issue }` : une propriété par
          // étiquette, plus deux champs de forme. `type` n'est pas une étiquette
          // CAA — l'oublier ferait comparer « 0 type CAA » au lieu de
          // « 0 issue pki.goog ».
          const critical = record.critical ?? 0;
          const entry = Object.entries(record).find(
            ([key]) => key !== 'critical' && key !== 'type',
          );
          return entry ? `${critical} ${entry[0]} ${String(entry[1])}` : `${critical} ?`;
        }),
        minTtl: null,
      };
    }
    default: {
      // TXT. Node rend les morceaux d'une même chaîne séparément : on les
      // recolle, parce qu'un TXT découpé à 255 octets reste une seule valeur.
      const records = await resolver.resolveTxt(name);
      return { values: records.map((chunks) => chunks.join('')), minTtl: null };
    }
  }
}

/** `ENOTFOUND` et `ENODATA` sont des constats, pas des pannes du worker. */
const EMPTY_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * Longueur retenue d'une liste de valeurs, en caractères.
 *
 * Un domaine sérieux porte volontiers dix-sept TXT (SPF, DKIM, DMARC et une
 * preuve de propriété par prestataire) : les recopier entiers dans `metrics`,
 * puis à nouveau dans `unexpected`, puis dans le message d'alerte, ferait
 * quelques kilooctets par mesure — quatre-vingt-seize mesures par jour et par
 * sonde. On coupe : ce qui compte dans une alerte tient dans les premières
 * valeurs, et la liste complète se relit d'un `dig`.
 */
const VALUES_MAX_CHARS = 400;

function summarize(values: readonly string[]): string | null {
  if (values.length === 0) return null;
  const joined = values.join(', ');
  if (joined.length <= VALUES_MAX_CHARS) return joined;
  const kept: string[] = [];
  let size = 0;
  for (const value of values) {
    if (size + value.length > VALUES_MAX_CHARS) break;
    kept.push(value);
    size += value.length + 2;
  }
  const hidden = values.length - kept.length;
  return `${kept.join(', ')}… (+${hidden})`;
}

async function runDns(config: DnsConfig, allowlist: readonly Cidr[]): Promise<CheckResult> {
  const name = normalizeDnsName(config.name);

  const resolver = new Resolver({ timeout: config.timeoutMs, tries: 1 });
  if (config.resolver !== null) {
    // Un résolveur **déclaré** est une saisie d'utilisateur : il passe par la
    // garde, comme n'importe quelle cible de connexion. C'est le seul endroit
    // de cette sonde où une adresse est jugée.
    const verdict = checkAddress(config.resolver, allowlist);
    if (!verdict.allowed) {
      return {
        outcome: 'unreachable',
        latencyMs: null,
        detail: `résolveur refusé — ${verdict.reason}`,
        metrics: { resolver: config.resolver },
      };
    }
    resolver.setServers([config.resolver]);
  }

  const resolverLabel = config.resolver ?? `système (${resolver.getServers().join(', ')})`;
  const expected = parseExpectedRecords(config.recordType, config.expected);

  const started = performance.now();
  let answer: Answer;
  try {
    answer = await query(resolver, name, config.recordType);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    const resolveMs = Math.round(performance.now() - started);
    // Le nom n'existe pas, ou n'a pas d'enregistrement de ce type. Le résolveur
    // a répondu : ce n'est pas `unreachable`, c'est une réponse qui n'est pas
    // celle qu'on attend. La nuance compte — `unreachable` voudrait dire « je
    // n'ai pas pu regarder », alors qu'ici on a bien regardé.
    if (EMPTY_CODES.has(code)) {
      return {
        outcome: 'unhealthy',
        latencyMs: resolveMs,
        detail:
          code === 'ENOTFOUND'
            ? `le nom « ${name} » n'existe pas (NXDOMAIN)`
            : `« ${name} » n'a aucun enregistrement ${config.recordType}`,
        metrics: { resolveMs, recordCount: 0, values: null, resolver: resolverLabel },
      };
    }
    return {
      outcome: 'unreachable',
      latencyMs: null,
      detail: messageOf(error),
      metrics: { resolver: resolverLabel },
    };
  }

  const resolveMs = Math.round(performance.now() - started);
  const metrics = {
    resolveMs,
    recordCount: answer.values.length,
    // `metrics` n'accepte que nombre, chaîne ou `null` : une liste se sérialise.
    // La virgule est un séparateur d'affichage, pas de données — la comparaison,
    // elle, travaille sur la liste.
    values: summarize(answer.values),
    resolver: resolverLabel,
    minTtl: answer.minTtl,
    missing: null as string | null,
    unexpected: null as string | null,
  };

  if (answer.values.length === 0) {
    return {
      outcome: 'unhealthy',
      latencyMs: resolveMs,
      detail: `« ${name} » n'a aucun enregistrement ${config.recordType}`,
      metrics,
    };
  }

  // Aucune valeur déclarée : la sonde constate la présence, et c'est tout ce
  // qu'elle prétend faire. C'est le réglage utile pour « ce nom résout-il
  // encore », sans avoir à figer une adresse qui bouge légitimement (CDN,
  // bascule d'hébergeur).
  if (expected.length === 0) {
    return { outcome: 'healthy', latencyMs: resolveMs, detail: null, metrics };
  }

  const comparison = compareDnsRecords({
    type: config.recordType,
    expected,
    actual: answer.values,
    match: config.match,
  });

  metrics.missing = summarize(comparison.missing);
  metrics.unexpected = summarize(comparison.unexpected);

  if (!comparison.ok) {
    return {
      outcome: 'unhealthy',
      latencyMs: resolveMs,
      detail: `${config.recordType} de « ${name} » : ${describeDnsComparison(comparison, VALUES_MAX_CHARS)}`,
      metrics,
    };
  }

  return { outcome: 'healthy', latencyMs: resolveMs, detail: null, metrics };
}

export const dnsProbe: MonitorProbe = {
  type: 'dns',
  async run(config, ctx: ProbeContext): Promise<CheckResult> {
    const parsed = dnsConfigSchema.safeParse(config);
    if (!parsed.success) {
      return {
        outcome: 'unreachable',
        latencyMs: null,
        detail: `configuration de sonde invalide : ${parsed.error.issues.map((issue) => issue.message).join(', ')}`,
        metrics: {},
      };
    }
    return runDns(parsed.data, ctx.allowlist);
  },
};
