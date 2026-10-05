import { readCoreAsset } from './assets.js';

/**
 * Loading the system prompt.
 *
 * The prompt lives in `src/ai/prompts/generate-appspec.md`, versioned like code
 * — never hard-coded in a TypeScript file. It carries `{{FIXTURE:name.json}}`
 * marks that are replaced by the **real** content of the repository's fixtures.
 *
 * Copying the fixtures into the markdown would have been simpler, and wrong: the
 * few-shot examples would have drifted the day a fixture changes, with nothing
 * to report it. Here, a modified fixture modifies the prompt.
 */

const FIXTURE_PATTERN = /\{\{FIXTURE:([a-z0-9._-]+)\}\}/g;
/** The same pattern, without `g`: `test()` on a global regex is stateful. */
const HAS_FIXTURE_MARK = /\{\{FIXTURE:[a-z0-9._-]+\}\}/;

export const GENERATE_APPSPEC_PROMPT_FILE = 'ai/prompts/generate-appspec.md' as const;

/** Fixtures allowed as examples. An allow list: the prompt does not read the disk as it pleases. */
const ALLOWED_FIXTURES = new Set(['simple.json', 'fullstack.json', 'invalid.json']);

function fixtureContent(name: string): string {
  if (!ALLOWED_FIXTURES.has(name)) {
    throw new Error(`fixture "${name}" not allowed in the system prompt`);
  }
  // The original JSON is indented for human review: we publish it again as is,
  // the model reads better what is airy.
  return readCoreAsset(`spec/__fixtures__/${name}`, {
    expectation: 'a JSON object carrying a "name" field',
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

/** Complete system prompt, fixtures substituted. */
export function generateAppSpecPrompt(): string {
  if (cached !== null) return cached;

  const template = readCoreAsset(GENERATE_APPSPEC_PROMPT_FILE, {
    // Sentinel: a file that does not carry its substitution marks is not our
    // prompt, whatever the path it comes from says.
    expectation: 'the system prompt’s {{FIXTURE:…}} marks',
    looksRight: (content) => HAS_FIXTURE_MARK.test(content),
  });

  const prompt = template.replace(FIXTURE_PATTERN, (_match, name: string) =>
    fixtureContent(name),
  );

  // Belt and braces: a surviving mark would mean a fixture was not substituted,
  // and the model would receive an empty example.
  if (prompt.includes('{{FIXTURE:')) {
    throw new Error('system prompt: a {{FIXTURE:…}} mark was left unsubstituted');
  }

  cached = prompt;
  return cached;
}
