import { readCoreAsset } from './assets.js';

/**
 * Chargement du prompt système.
 *
 * Le prompt vit dans `src/ai/prompts/generate-appspec.md`, versionné comme du
 * code — jamais en dur dans un fichier TypeScript. Il porte des marques
 * `{{FIXTURE:nom.json}}` que l'on remplace par le contenu **réel** des fixtures
 * du jalon 4A.
 *
 * Recopier les fixtures dans le markdown aurait été plus simple, et faux : les
 * exemples few-shot auraient dérivé du jour où une fixture change, sans que rien
 * ne le signale. Ici, une fixture modifiée modifie le prompt.
 */

const FIXTURE_PATTERN = /\{\{FIXTURE:([a-z0-9._-]+)\}\}/g;
/** Même motif, sans `g` : `test()` sur une regex globale est à état. */
const HAS_FIXTURE_MARK = /\{\{FIXTURE:[a-z0-9._-]+\}\}/;

export const GENERATE_APPSPEC_PROMPT_FILE = 'ai/prompts/generate-appspec.md' as const;

/** Fixtures autorisées en exemple. Une liste blanche : le prompt ne lit pas le disque à sa guise. */
const ALLOWED_FIXTURES = new Set(['simple.json', 'fullstack.json', 'invalid.json']);

function fixtureContent(name: string): string {
  if (!ALLOWED_FIXTURES.has(name)) {
    throw new Error(`fixture « ${name} » non autorisée dans le prompt système`);
  }
  // Le JSON d'origine est indenté pour la relecture humaine : on le republie
  // tel quel, le modèle lit mieux ce qui est aéré.
  return readCoreAsset(`spec/__fixtures__/${name}`, {
    expectation: 'un objet JSON portant un champ « name »',
    looksRight: (content) => {
      try {
        const parsed: unknown = JSON.parse(content);
        return typeof parsed === 'object' && parsed !== null && 'name' in parsed;
      } catch {
        return false;
      }
    },
  }).trim();
}

let cached: string | null = null;

/** Prompt système complet, fixtures substituées. */
export function generateAppSpecPrompt(): string {
  if (cached !== null) return cached;

  const template = readCoreAsset(GENERATE_APPSPEC_PROMPT_FILE, {
    // Sentinelle : un fichier qui ne porte pas ses marques de substitution
    // n'est pas notre prompt, quoi qu'en dise le chemin d'où il vient.
    expectation: 'les marques {{FIXTURE:…}} du prompt système',
    looksRight: (content) => HAS_FIXTURE_MARK.test(content),
  });

  const prompt = template.replace(FIXTURE_PATTERN, (_match, name: string) =>
    fixtureContent(name),
  );

  // Ceinture et bretelles : une marque survivante voudrait dire qu'une fixture
  // n'a pas été substituée, et le modèle recevrait un exemple vide.
  if (prompt.includes('{{FIXTURE:')) {
    throw new Error('prompt système : une marque {{FIXTURE:…}} est restée non substituée');
  }

  cached = prompt;
  return cached;
}
