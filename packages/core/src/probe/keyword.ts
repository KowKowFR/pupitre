import {
  keywordConfigSchema,
  type KeywordConfig,
  type KeywordMatching,
  type KeywordScope,
} from '../monitors/catalog.js';
import type { Cidr } from '../monitors/ssrf.js';
import type { CheckResult } from '../monitors/state.js';
import { certificateMetrics, decodeBody, guardedFetch } from './fetch.js';
import type { UiLanguage } from '../i18n.js';
import { probeSay } from './messages.js';
import type { MonitorProbe, ProbeContext } from './types.js';

/**
 * Sonde de mot-clé — « la page dit-elle ce qu'elle doit dire ? »
 *
 * Une sonde HTTP qui rend 200 prouve que *quelque chose* écoute. Elle ne prouve
 * pas que l'application marche : une page d'erreur applicative, un écran de
 * maintenance et un site défiguré rendent 200 avec le même entrain. Le mot-clé
 * est la frontière entre « le serveur répond » et « l'application répond ».
 *
 * ── Les trois arbitrages ────────────────────────────────────────────────────
 *
 * 1. **Présence et absence.** Voir `keywordConfigSchema` : deux besoins réels
 *    et opposés, tenus par la même requête.
 *
 * 2. **Sur quoi on cherche.** Par défaut la réponse *telle qu'elle est arrivée*.
 *    C'est le seul texte dont on puisse affirmer qu'il est bien celui qui a été
 *    servi. Chercher dans le « texte visible » supposerait un analyseur HTML :
 *    une dépendance de plus dans un paquet qui n'en a pas, et un analyseur qui
 *    se trompe transforme un site sain en fausse panne. Le mode `text` existe
 *    quand même — il est utile surtout pour un *texte interdit*, qu'un
 *    commentaire ou un attribut ferait sonner à tort — mais il est annoncé pour
 *    ce qu'il est : un dépouillement par expressions régulières, pas un
 *    analyseur. Il ne prétend rien de plus, ni dans le code ni dans l'écran.
 *
 * 3. **Casse, accents, espaces.** Le mode souple est le défaut, parce que le
 *    faux positif de trois heures du matin est le vrai danger : un mot-clé qui
 *    échoue sur une espace insécable ou une majuscule apprend à l'astreinte à
 *    ignorer les alertes. Le mode strict reste disponible pour qui surveille un
 *    jeton exact plutôt qu'une phrase.
 *
 * ── Ce qu'elle ne fait pas ──────────────────────────────────────────────────
 * Elle n'exécute pas de JavaScript. Sur une application entièrement rendue par
 * le navigateur, le corps servi ne contient souvent rien d'autre qu'un `<div
 * id="root">` : le mot-clé sera absent, et ce ne sera pas un mensonge de la
 * sonde mais une propriété de la page. C'est écrit dans `neverDoes`.
 */

// ─── normalisation ────────────────────────────────────────────────────────────

/** Toutes les espaces Unicode, y compris l'insécable et la fine insécable. */
const ANY_SPACE = /\s+/gu;
/** Marques combinantes, ce qui reste des accents après décomposition NFD. */
const COMBINING = /\p{M}+/gu;

/**
 * Le texte tel qu'on le compare en mode souple.
 *
 * L'ordre compte. NFKC d'abord : c'est lui qui ramène l'espace insécable
 * (U+00A0), l'espace fine (U+202F) et les ligatures à leur forme ordinaire.
 * Puis la casse, puis NFD + retrait des marques pour les accents, puis
 * l'écrasement des suites d'espaces — un retour à la ligne dans le HTML au
 * milieu de « Se  connecter » ne doit pas compter comme une différence.
 *
 * La même fonction est appliquée au texte cherché **et** au texte cherché
 * dedans : c'est la seule façon que la comparaison soit symétrique.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING, '')
    .replace(ANY_SPACE, ' ')
    .trim();
}

const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const TAG = /<\/?[a-z][^>]*>/gi;
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Retire les balises — **approximation assumée**, pas un analyseur.
 *
 * Elle se trompe sur un `<` littéral dans du texte, sur un `>` dans une valeur
 * d'attribut, sur du CDATA. Ces cas existent et ils sont rares ; ce qui l'est
 * beaucoup moins, c'est « Erreur 500 » dans un commentaire HTML ou dans un
 * `alt`, qui ferait sonner un texte interdit sans qu'aucun visiteur ne l'ait lu.
 * Le choix est offert, pas imposé : le mode par défaut reste la réponse brute.
 *
 * Les blocs `<script>` et `<style>` partent en premier, avec leur contenu : le
 * JSON d'hydratation d'une application moderne y contient à peu près tous les
 * mots de la page, y compris ceux qu'elle n'affiche pas.
 */
export function stripMarkup(html: string): string {
  return html
    .replace(SCRIPT_OR_STYLE, ' ')
    .replace(COMMENT, ' ')
    .replace(TAG, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
      const lower = body.toLowerCase();
      if (lower.startsWith('#x')) {
        const code = Number.parseInt(lower.slice(2), 16);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
      }
      if (lower.startsWith('#')) {
        const code = Number.parseInt(lower.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
      }
      return NAMED_ENTITIES[lower] ?? whole;
    });
}

/** Le texte dans lequel on cherchera, selon la portée demandée. */
function haystackOf(body: string, scope: KeywordScope): string {
  return scope === 'text' ? stripMarkup(body) : body;
}

/** La recherche elle-même, sans réseau — c'est elle que les tests éprouvent. */
export function containsKeyword(
  haystack: string,
  needle: string,
  matching: KeywordMatching,
): boolean {
  if (matching === 'strict') return haystack.includes(needle);
  return foldForSearch(haystack).includes(foldForSearch(needle));
}

// ─── verdict ──────────────────────────────────────────────────────────────────

async function runKeyword(
  config: KeywordConfig,
  allowlist: readonly Cidr[],
  language: UiLanguage,
): Promise<CheckResult> {
  const say = probeSay(language);
  const maxBytes = config.maxKib * 1024;

  const result = await guardedFetch({
    url: config.url,
    // Toujours GET : chercher un mot dans un corps qu'on n'a pas demandé n'a
    // pas de sens, et HEAD n'en rend pas.
    method: 'GET',
    timeoutMs: config.timeoutMs,
    maxBytes,
    readBody: true,
    // La garde SSRF complète, redirections comprises : `guardedFetch` re-résout
    // et re-contrôle chaque saut. La sonde de mot-clé n'a pas sa propre boucle,
    // donc pas sa propre façon de l'oublier.
    allowlist,
    language,
  });

  if (!result.ok) {
    const outcome = result.kind === 'redirect' ? 'unhealthy' : 'unreachable';
    return {
      outcome,
      latencyMs: result.status === null ? null : result.latencyMs,
      detail: result.detail,
      metrics: {
        httpStatus: result.status,
        latencyMs: result.status === null ? null : result.latencyMs,
        bytesRead: 0,
        truncated: say('no'),
        redirects: result.redirects,
        address: result.address,
        finalUrl: result.finalUrl,
      },
    };
  }

  const metrics = {
    httpStatus: result.status,
    latencyMs: result.latencyMs,
    bytesRead: result.body.byteLength,
    truncated: result.truncated ? say('yes') : say('no'),
    redirects: result.redirects,
    address: result.address,
    finalUrl: result.finalUrl,
    ...certificateMetrics(result.certificate),
  };

  const verdict = (outcome: 'healthy' | 'unhealthy', detail: string | null): CheckResult => ({
    outcome,
    latencyMs: result.latencyMs,
    detail,
    metrics,
  });

  if (result.status !== config.expectedStatus) {
    return verdict(
      'unhealthy',
      say('http.status', { status: result.status, expected: config.expectedStatus }),
    );
  }

  const body = decodeBody(result.body, result.headers['content-type']);
  const haystack = haystackOf(body, config.scope);
  // La coupure se dit toujours, et jamais comme une absence : « je ne l'ai pas
  // trouvé » et « je n'ai pas fini de chercher » sont deux constats différents.
  const cut = result.truncated ? say('keyword.cut', { kib: config.maxKib }) : '';

  if (config.mustContain !== null && !containsKeyword(haystack, config.mustContain, config.matching)) {
    return verdict('unhealthy', say('keyword.missing', { text: config.mustContain, cut }));
  }

  if (
    config.mustNotContain !== null &&
    containsKeyword(haystack, config.mustNotContain, config.matching)
  ) {
    return verdict('unhealthy', say('keyword.forbidden', { text: config.mustNotContain }));
  }

  // Sain, mais pas muet : si la réponse a été coupée, l'absence du texte
  // interdit n'est établie que sur ce qu'on a lu. Le dire dans le détail vaut
  // mieux que de laisser croire à une preuve.
  const partial =
    result.truncated && config.mustNotContain !== null
      ? say('keyword.partial', { kib: config.maxKib })
      : null;

  return verdict('healthy', partial);
}

export const keywordProbe: MonitorProbe = {
  type: 'keyword',
  async run(config, ctx: ProbeContext): Promise<CheckResult> {
    const parsed = keywordConfigSchema.safeParse(config);
    if (!parsed.success) {
      return {
        outcome: 'unreachable',
        latencyMs: null,
        detail: probeSay(ctx.language)('invalidConfig', {
          issues: parsed.error.issues.map((issue) => issue.message).join(', '),
        }),
        metrics: {},
      };
    }
    return runKeyword(parsed.data, ctx.allowlist, ctx.language);
  },
};
