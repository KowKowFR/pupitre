/**
 * Multi-provider configuration of the AppSpec generation, offline.
 *
 *   pnpm test:ai
 *
 * No network call, no key: everything tried out here is ours.
 *
 * What is proven:
 *   1. The catalog is complete — each declared provider has a descriptor *and*
 *      a factory. A half-added provider is detected here.
 *   2. The default model follows the provider, and never the reverse.
 *   3. The fallback environment variable is **specific to the provider**:
 *      `OPENROUTER_API_KEY` enables nothing at OpenAI nor at Anthropic.
 *   4. A model that does not have the shape of a provider identifier is flagged
 *      before the call, and the warning names the right culprit.
 *   5. The settings schema accepts the three providers, refuses the others,
 *      and validates the base URL.
 *   6. `createModel` refuses to build without a key, naming the missing
 *      variable — and builds a model for each of the three, without network.
 *   7. The strict mode of structured outputs is disabled where it must be: the
 *      AppSpec produces a `oneOf` that OpenAI's strict mode refuses.
 *   8. A provider's error message is cleaned of anything that looks like a key
 *      — including the masked form OpenAI returns.
 *   9. The system prompt does carry the multi-service instruction, and **all**
 *      its valid spec examples pass `appSpecSchema` — except the two
 *      counter-examples, which must fail.
 *
 * The generation loop itself (retry on Zod errors, truncated response, text
 * outside JSON, provider failure) is tried out with a simulated model in
 * `packages/core/test/ai.test.ts`: the SDK's `MockLanguageModelV3` can only be
 * resolved from `packages/core`. `pnpm test` runs them.
 *
 * Exit code 1 as soon as a single point fails.
 */
import assert from 'node:assert/strict';
import { aiSettingsSchema, appSettingsPatchSchema, safeParseAppSpec } from '@pupitre/core';
import {
  AI_PROVIDERS,
  DEFAULT_TEMPERATURE,
  MissingApiKeyError,
  aiModelMismatch,
  aiProviderDescriptor,
  aiProviderDescriptors,
  appSpecJsonSchema,
  createModel,
  defaultAiModel,
  redactApiKey,
  generateAppSpecPrompt,
  getAiProviderFactory,
  isAiProvider,
  resolveAiConfig,
  type AiProvider,
} from '@pupitre/core/ai';

const ESC = String.fromCharCode(27);
const paint = (code: string) => (text: string) => `${ESC}[${code}m${text}${ESC}[0m`;
const bold = paint('1');
const green = paint('32');
const red = paint('31');
const dim = paint('2');

let failures = 0;
let checks = 0;

function step(title: string): void {
  process.stdout.write(`\n${bold(title)}\n`);
}

function ok(message: string): void {
  process.stdout.write(`  ${green('✓')} ${message}\n`);
}

function ko(message: string, detail: string): void {
  failures += 1;
  process.stdout.write(`  ${red('✗')} ${message}\n      ${dim(detail)}\n`);
}

function check(message: string, assertion: () => void): void {
  checks += 1;
  try {
    assertion();
    ok(message);
  } catch (error) {
    ko(message, error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error));
  }
}

function info(message: string): void {
  process.stdout.write(`    ${dim(message)}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────

step('1. The providers catalog is complete');
{
  info(`declared providers: ${AI_PROVIDERS.join(', ')}`);

  check('at least OpenRouter, OpenAI and Anthropic', () => {
    for (const expected of ['openrouter', 'openai', 'anthropic']) {
      assert.ok(AI_PROVIDERS.includes(expected as AiProvider), `${expected} absent`);
    }
  });

  for (const provider of AI_PROVIDERS) {
    check(`"${provider}" has a usable descriptor`, () => {
      const descriptor = aiProviderDescriptor(provider);
      assert.equal(descriptor.key, provider);
      assert.ok(descriptor.label.length > 0, 'empty label');
      assert.ok(descriptor.defaultModel.length > 0, 'empty default model');
      assert.ok(descriptor.modelHint.length > 0, 'empty model example');
      // The provider's default must itself pass its own shape test, otherwise the
      // panel would warn itself from the installation on.
      assert.ok(
        descriptor.nativeModel.test(descriptor.defaultModel),
        `the default "${descriptor.defaultModel}" does not look like a ${descriptor.label} identifier`,
      );
    });

    check(`"${provider}" has a factory`, () => {
      assert.equal(typeof getAiProviderFactory(provider), 'function');
    });
  }

  check('the descriptors and the list do not diverge', () => {
    assert.deepEqual(
      aiProviderDescriptors().map((descriptor) => descriptor.key),
      AI_PROVIDERS,
    );
  });

  check('a made-up provider is rejected', () => {
    assert.equal(isAiProvider('mistral'), false);
    assert.equal(isAiProvider(''), false);
    assert.equal(isAiProvider(null), false);
    assert.equal(isAiProvider('openrouter'), true);
  });
}

step('2. The default model follows the provider');
{
  for (const provider of AI_PROVIDERS) {
    check(`${provider} → ${defaultAiModel(provider)}`, () => {
      const resolved = resolveAiConfig({
        language: 'fr',
        settings: { provider, enabled: true },
        settingsApiKey: 'sk-test',
      });
      assert.equal(resolved.provider, provider);
      assert.equal(resolved.model, defaultAiModel(provider));
      assert.equal(resolved.modelSource, 'default');
    });
  }

  check('two providers do not have the same default', () => {
    const defaults = AI_PROVIDERS.map(defaultAiModel);
    assert.equal(new Set(defaults).size, defaults.length);
  });

  check('a model set by hand wins over the default', () => {
    const resolved = resolveAiConfig({
      language: 'fr',
      settings: { provider: 'anthropic', model: 'claude-opus-4-5' },
      settingsApiKey: 'sk-test',
    });
    assert.equal(resolved.model, 'claude-opus-4-5');
    assert.equal(resolved.modelSource, 'settings');
  });

  check('an unknown provider in the database falls back on OpenRouter, without crashing', () => {
    const resolved = resolveAiConfig({
      language: 'fr',
      settings: { provider: 'skynet' },
      settingsApiKey: 'sk-test',
    });
    assert.equal(resolved.provider, 'openrouter');
  });
}

step("3. The fallback environment variable is specific to the provider");
{
  const env = {
    OPENROUTER_API_KEY: 'sk-or-xxx',
    OPENROUTER_MODEL: 'openai/gpt-5',
  };

  check('OpenRouter lit OPENROUTER_API_KEY', () => {
    const resolved = resolveAiConfig({ language: 'fr', settings: { provider: 'openrouter' }, env });
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.keySource, 'env');
    assert.equal(resolved.model, 'openai/gpt-5');
    assert.equal(resolved.modelSource, 'env');
  });

  for (const provider of ['openai', 'anthropic'] as const) {
    check(`${provider} ignores OPENROUTER_API_KEY — no key, no generation`, () => {
      const resolved = resolveAiConfig({ language: 'fr', settings: { provider }, env });
      assert.equal(resolved.enabled, false);
      assert.equal(resolved.keySource, 'none');
      assert.equal(resolved.apiKey, undefined);
      // And above all: it does not take OpenRouter's model either.
      assert.equal(resolved.model, defaultAiModel(provider));
    });
  }

  check('OpenAI lit OPENAI_API_KEY, Anthropic lit ANTHROPIC_API_KEY', () => {
    const full = {
      ...env,
      OPENAI_API_KEY: 'sk-oa-xxx',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      ANTHROPIC_MODEL: 'claude-haiku-4-5',
    };
    const openai = resolveAiConfig({ language: 'fr', settings: { provider: 'openai' }, env: full });
    assert.equal(openai.enabled, true);
    assert.equal(openai.apiKey, 'sk-oa-xxx');

    const anthropic = resolveAiConfig({
      language: 'fr',
      settings: { provider: 'anthropic' },
      env: full,
    });
    assert.equal(anthropic.apiKey, 'sk-ant-xxx');
    assert.equal(anthropic.model, 'claude-haiku-4-5');
  });

  check("the settings' key takes precedence over the environment's", () => {
    const resolved = resolveAiConfig({
      language: 'fr',
      settings: { provider: 'openrouter' },
      settingsApiKey: 'sk-settings',
      env,
    });
    assert.equal(resolved.apiKey, 'sk-settings');
    assert.equal(resolved.keySource, 'settings');
  });

  check('the switch cuts the generation even with a key', () => {
    const resolved = resolveAiConfig({
      language: 'fr',
      settings: { provider: 'openrouter', enabled: false },
      settingsApiKey: 'sk-settings',
    });
    assert.equal(resolved.enabled, false);
    assert.equal(resolved.apiKey, 'sk-settings', 'the key stays resolved, only the generation is switched off');
  });

  check('the base URL is only kept by the providers that declare it', () => {
    const openai = resolveAiConfig({
      language: 'fr',
      settings: { provider: 'openai', baseUrl: 'https://llm.internal/v1' },
      settingsApiKey: 'k',
    });
    assert.equal(openai.baseUrl, 'https://llm.internal/v1');

    const anthropic = resolveAiConfig({
      language: 'fr',
      settings: { provider: 'anthropic', baseUrl: 'https://llm.internal/v1' },
      settingsApiKey: 'k',
    });
    assert.equal(anthropic.baseUrl, undefined, 'Anthropic does not declare supportsBaseUrl');
  });
}

step('4. A model inconsistent with the provider is flagged');
{
  check('OpenRouter + "gpt-5.2" → warned, and OpenAI is named', () => {
    const warning = aiModelMismatch('openrouter', 'gpt-5.2', { language: 'fr' });
    assert.ok(warning, 'no warning');
    assert.match(warning, /OpenAI/);
  });

  check('Anthropic + "anthropic/claude-sonnet-4.5" → warned, OpenRouter is named', () => {
    const warning = aiModelMismatch('anthropic', 'anthropic/claude-sonnet-4.5', { language: 'fr' });
    assert.ok(warning);
    assert.match(warning, /OpenRouter/);
  });

  check('OpenAI + "claude-sonnet-4-5" → warned, Anthropic is named', () => {
    const warning = aiModelMismatch('openai', 'claude-sonnet-4-5', { language: 'fr' });
    assert.ok(warning);
    assert.match(warning, /Anthropic/);
  });

  check('a native identifier triggers nothing', () => {
    assert.equal(
      aiModelMismatch('openrouter', 'anthropic/claude-sonnet-4.5', { language: 'fr' }),
      null,
    );
    assert.equal(aiModelMismatch('openai', 'gpt-4.1', { language: 'fr' }), null);
    assert.equal(aiModelMismatch('openai', 'o3-mini', { language: 'fr' }), null);
    assert.equal(aiModelMismatch('anthropic', 'claude-opus-4-5', { language: 'fr' }), null);
  });

  check('a custom base URL suspends the warning', () => {
    assert.equal(
      aiModelMismatch('openai', 'mixtral-8x7b-instruct', {
        language: 'fr',
        baseUrl: 'https://llm.internal/v1',
      }),
      null,
    );
    assert.ok(aiModelMismatch('openai', 'mixtral-8x7b-instruct', { language: 'fr' }));
  });

  check('resolveAiConfig carries the warning to the route', () => {
    const resolved = resolveAiConfig({
      language: 'fr',
      settings: { provider: 'anthropic', model: 'anthropic/claude-sonnet-4.5' },
      settingsApiKey: 'k',
    });
    assert.ok(resolved.modelWarning, 'no warning brought up');
  });
}

step('5. The instance settings accept the three providers');
{
  for (const provider of AI_PROVIDERS) {
    check(`"${provider}" is a valid value`, () => {
      const parsed = aiSettingsSchema.parse({ provider, model: defaultAiModel(provider) });
      assert.equal(parsed.provider, provider);
    });
  }

  check('a provider outside the catalog is refused', () => {
    assert.equal(aiSettingsSchema.safeParse({ provider: 'skynet' }).success, false);
  });

  check('a shaky base URL is refused at the entrance', () => {
    assert.equal(aiSettingsSchema.safeParse({ baseUrl: 'not-a-url' }).success, false);
    assert.equal(aiSettingsSchema.safeParse({ baseUrl: '' }).success, true);
    assert.equal(aiSettingsSchema.safeParse({ baseUrl: 'https://llm/v1' }).success, true);
  });

  check('a partial PATCH does not reset the rest of the AI section', () => {
    const patch = appSettingsPatchSchema.parse({ ai: { provider: 'openai' } });
    assert.deepEqual(patch.ai, { provider: 'openai' });
    assert.equal('model' in (patch.ai ?? {}), false, 'the model would be overwritten by a default');
  });

  check('the temperature and the token cap stay bounded', () => {
    assert.equal(aiSettingsSchema.safeParse({ temperature: 3 }).success, false);
    assert.equal(aiSettingsSchema.safeParse({ maxTokens: 10 }).success, false);
    assert.equal(aiSettingsSchema.parse({}).temperature, DEFAULT_TEMPERATURE);
  });
}

step('6. createModel refuses without a key, and builds with one');
{
  for (const provider of AI_PROVIDERS) {
    const descriptor = aiProviderDescriptor(provider);

    check(`"${provider}" without a key → MissingApiKeyError naming the right variable`, () => {
      assert.throws(
        () => createModel({ provider, apiKey: undefined }),
        (error: unknown) => {
          assert.ok(error instanceof MissingApiKeyError);
          assert.equal(error.provider, provider);
          assert.match(error.message, new RegExp(descriptor.label));
          if (descriptor.envApiKeyVar) {
            assert.match(error.message, new RegExp(descriptor.envApiKeyVar));
          }
          return true;
        },
      );
      assert.throws(() => createModel({ provider, apiKey: '   ' }), MissingApiKeyError);
    });

    check(`"${provider}" with a key → a model, without network`, () => {
      const configured = createModel({ provider, apiKey: 'sk-test-offline' });
      assert.equal(typeof configured.model, 'object');
      assert.ok(configured.model !== null);
    });
  }

  check('without a provider specified, we stay on OpenRouter (compatibility)', () => {
    assert.throws(
      () => createModel({ apiKey: undefined }),
      (error: unknown) => {
        assert.ok(error instanceof MissingApiKeyError);
        assert.equal(error.provider, 'openrouter');
        return true;
      },
    );
  });

  check('a base URL is accepted by OpenAI without opening a connection', () => {
    const configured = createModel({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'mixtral-8x7b',
      baseUrl: 'https://llm.internal/v1',
    });
    assert.ok(configured.model);
  });
}

step('7. The schema sent to the provider, and what each one can do with it');
{
  // Observed against the real OpenAI API, with a real key:
  //   Invalid schema for response_format 'AppSpec': In context=('properties',
  //   'services','items','properties','source'), 'oneOf' is not permitted.
  // The cause is here, and it is structural: `source` is a discriminatedUnion,
  // which Zod translates into `oneOf`.
  const jsonSchema = JSON.stringify(appSpecJsonSchema());

  check("the AppSpec's schema does contain a \"oneOf\"", () => {
    assert.ok(
      jsonSchema.includes('"oneOf"'),
      'no more oneOf: if the AppSpec changed, this safeguard must be reviewed',
    );
  });

  // The strict mode also requires `additionalProperties: false` everywhere and
  // all the properties in `required`; the AppSpec carries `default`s and bounds.
  // Fitting it into that mold would mean maintaining an impoverished schema in
  // parallel. We disable the strict mode instead.
  check('the AppSpec carries defaults and bounds, incompatible with the strict mode', () => {
    assert.ok(/"default"/.test(jsonSchema) || /"minimum"/.test(jsonSchema), jsonSchema.slice(0, 200));
  });

  check('OpenAI gets strictJsonSchema: false', () => {
    const configured = createModel({ provider: 'openai', apiKey: 'sk-test' });
    assert.deepEqual(configured.callOptions, { openai: { strictJsonSchema: false } });
  });

  check('OpenRouter builds its model outside the strict mode', () => {
    // The setting is applied when the model is built: we check that it did reach
    // the model, and not only that we wrote it.
    const configured = createModel({ provider: 'openrouter', apiKey: 'sk-test' });
    const settings = (configured.model as unknown as { settings?: unknown }).settings;
    assert.deepEqual(settings, { structuredOutputs: { strict: false } }, JSON.stringify(settings));
  });

  check('Anthropic has no option to set — it goes through the tool call', () => {
    const configured = createModel({ provider: 'anthropic', apiKey: 'sk-test' });
    assert.deepEqual(configured.callOptions, {});
  });

  check('each provider returns a model AND its call options', () => {
    for (const provider of AI_PROVIDERS) {
      const configured = createModel({ provider, apiKey: 'sk-test' });
      assert.ok(configured.model, `${provider}: no model`);
      assert.equal(typeof configured.callOptions, 'object', `${provider}: no options`);
    }
  });
}

step("8. A provider's message is cleaned before being relayed");
{
  const key = 'sk-sentinelle-verif-ia-0000000000000000';

  check('the exact key disappears from the message', () => {
    const cleaned = redactApiKey(`401 rejected key ${key}`, key, 'fr');
    assert.ok(!cleaned.includes(key), cleaned);
    assert.match(cleaned, /clé masquée/);
  });

  // Observed for real against the OpenAI API: the provider copies the first eight
  // and the last four characters of the key. A mask that leaves twelve characters
  // in clear is not a mask.
  check('the form masked by OpenAI disappears too', () => {
    const masked =
      'Incorrect API key provided: sk-senti***************************0000. You can find…';
    const cleaned = redactApiKey(masked, key, 'fr');
    assert.ok(!cleaned.includes('sk-senti'), cleaned);
    assert.match(cleaned, /clé masquée/);
  });

  check("the other providers' forms are covered", () => {
    for (const sample of ['sk-ant-api03-AbCdEf', 'sk-or-v1-0123456789', 'gsk_ABCDEFGHIJ']) {
      assert.ok(!redactApiKey(`error: ${sample}`, undefined, 'fr').includes(sample), sample);
    }
  });

  check('a message without a key goes through intact', () => {
    const message = 'The model did not answer within the allotted time';
    assert.equal(redactApiKey(message, key, 'fr'), message);
  });
}

step('9. The system prompt guides toward a multi-service application');
{
  const prompt = generateAppSpecPrompt();
  info(`${prompt.length} characters`);

  check('the "off-the-shelf application + its database" instruction is in it', () => {
    assert.match(prompt, /comes with its database/i);
    assert.match(prompt, /GLPI/);
    assert.match(prompt, /dependsOn/);
  });

  check('the "no made-up secret" rule is explicit', () => {
    assert.match(prompt, /\*\*never\*\*\s+make up a secret value/i);
    assert.match(prompt, /changeme/);
  });

  check('no fixture mark survives', () => {
    assert.ok(!prompt.includes('{{FIXTURE:'));
  });

  // The point that matters: a wrong example in the prompt teaches the model to
  // produce wrong output. So each JSON block is set against the real schema.
  //
  // Not all blocks are whole specs: some are **excerpts** — two services shown
  // side by side to illustrate the secret alias, without the noise of the
  // sources and probes. Confusing them with specs made this check fail on a
  // perfectly legitimate block, and the only way to silence it would have been
  // to inflate the excerpt until it drowned what it shows.
  //
  // The distinction reads in the shape, not in an annotation one would forget to
  // set: a spec is an object carrying `name` and `services`. An excerpt is only
  // exempt from the domain validation, never from the syntax — unreadable JSON in
  // a prompt teaches the model to write some.
  const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? '');
  info(`${blocks.length} JSON blocks in the prompt`);

  const parsed = blocks.map((block, index) => {
    try {
      return { index, value: JSON.parse(block) as unknown, readable: true };
    } catch {
      return { index, value: undefined, readable: false };
    }
  });

  check("all the prompt's JSON blocks can be parsed", () => {
    const broken = parsed.filter((block) => !block.readable).map((block) => `#${block.index + 1}`);
    assert.equal(broken.length, 0, `unreadable block(s): ${broken.join(', ')}`);
  });

  const isSpec = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && 'name' in value && 'services' in value;

  const specs = parsed.filter((block) => block.readable && isSpec(block.value));
  info(`${specs.length} whole spec(s), ${parsed.length - specs.length} excerpt(s)`);

  const verdicts = specs.map((block) => safeParseAppSpec(block.value).success);

  const valid = verdicts.filter(Boolean).length;
  const invalid = verdicts.length - valid;

  check('at least three valid examples', () => {
    assert.ok(valid >= 3, `${valid} exemple(s) valide(s) seulement`);
  });

  check('exactly two invalid counter-examples — not one more', () => {
    // The two intended ones: `invalid.json`, and the refusal spec `{ services: [] }`.
    // A third would mean that an example supposed to be correct is not.
    assert.equal(
      invalid,
      2,
      `${invalid} invalid block(s): ` +
        specs
          .filter((_, position) => !verdicts[position])
          .map((block) => `#${block.index + 1}`)
          .join(', '),
    );
  });

  check('the off-the-shelf example does link its two services', () => {
    const wordpress = blocks
      .map((block) => {
        try {
          return JSON.parse(block) as unknown;
        } catch {
          return null;
        }
      })
      .find(
        (spec): spec is { name: string } =>
          typeof spec === 'object' && spec !== null && 'name' in spec && spec.name === 'wordpress',
      );
    assert.ok(wordpress, '"wordpress" example not found in the prompt');

    const parsed = safeParseAppSpec(wordpress);
    assert.ok(parsed.success, 'the example does not pass appSpecSchema');
    const spec = parsed.data;

    assert.equal(spec.services.length, 2, 'the application and its database');
    const app = spec.services.find((service) => service.exposed);
    const db = spec.services.find((service) => !service.exposed);
    assert.ok(app && db);
    assert.deepEqual(app.dependsOn, [db.name], 'the application depends on its database');
    assert.ok(
      Object.values(app.env).some((value) => value.startsWith(db.name)),
      'the application addresses the database by the service name',
    );
    assert.ok(db.volumes.length > 0, 'the database has no volume');
    assert.ok(db.healthcheck.port !== undefined, 'the database is probed on its port');
    assert.ok(app.secrets.length > 0 && db.secrets.length > 0, 'passwords not declared');
    // And above all: no secret value in `env`.
    for (const service of spec.services) {
      for (const [key, value] of Object.entries(service.env)) {
        assert.ok(
          !/PASSWORD|SECRET|TOKEN|API_KEY/.test(key),
          `"${key}=${value}": a secret leaked into env`,
        );
      }
    }
  });
}

step('Summary');
if (failures === 0) {
  process.stdout.write(`  ${green('✓')} ${checks} checks, no failure\n\n`);
} else {
  process.stdout.write(`  ${red('✗')} ${failures} failure(s) out of ${checks} checks\n\n`);
  process.exit(1);
}
