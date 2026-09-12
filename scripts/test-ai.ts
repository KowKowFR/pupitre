/**
 * Configuration multi-fournisseur de la génération d'AppSpec, hors ligne.
 *
 *   pnpm test:ai
 *
 * Aucun appel réseau, aucune clé : tout ce qui est éprouvé ici est à nous.
 *
 * Ce qui est prouvé :
 *   1. Le catalogue est complet — chaque fournisseur déclaré a un descripteur
 *      *et* une fabrique. Un fournisseur ajouté à moitié est détecté ici.
 *   2. Le modèle par défaut suit le fournisseur, et jamais l'inverse.
 *   3. La variable d'environnement de repli est **propre au fournisseur** :
 *      `OPENROUTER_API_KEY` n'active rien chez OpenAI ni chez Anthropic.
 *   4. Un modèle qui n'a pas la forme d'un identifiant du fournisseur est
 *      signalé avant l'appel, et l'avertissement nomme le bon coupable.
 *   5. Le schéma de paramètres accepte les trois fournisseurs, refuse les
 *      autres, et valide l'URL de base.
 *   6. `createModel` refuse de se construire sans clé, en nommant la variable
 *      qui manque — et construit un modèle pour chacun des trois, sans réseau.
 *   7. Le mode strict des sorties structurées est désactivé là où il faut :
 *      l'AppSpec produit un `oneOf` que le mode strict d'OpenAI refuse.
 *   8. Le message d'erreur d'un fournisseur est nettoyé de tout ce qui
 *      ressemble à une clé — y compris de la forme masquée qu'OpenAI renvoie.
 *   9. Le prompt système porte bien la consigne multi-services, et **tous** ses
 *      exemples de spec valide passent `appSpecSchema` — sauf les deux
 *      contre-exemples, qui doivent échouer.
 *
 * La boucle de génération elle-même (relance sur erreurs Zod, réponse tronquée,
 * texte hors JSON, panne du fournisseur) est éprouvée avec un modèle simulé
 * dans `packages/core/test/ai.test.ts` : le `MockLanguageModelV3` du SDK n'est
 * résoluble que depuis `packages/core`. `pnpm test` les exécute.
 *
 * Sortie en code 1 dès qu'un seul point échoue.
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

step('1. Le catalogue des fournisseurs est complet');
{
  info(`fournisseurs déclarés : ${AI_PROVIDERS.join(', ')}`);

  check('au moins OpenRouter, OpenAI et Anthropic', () => {
    for (const expected of ['openrouter', 'openai', 'anthropic']) {
      assert.ok(AI_PROVIDERS.includes(expected as AiProvider), `${expected} absent`);
    }
  });

  for (const provider of AI_PROVIDERS) {
    check(`« ${provider} » a un descripteur exploitable`, () => {
      const descriptor = aiProviderDescriptor(provider);
      assert.equal(descriptor.key, provider);
      assert.ok(descriptor.label.length > 0, 'libellé vide');
      assert.ok(descriptor.defaultModel.length > 0, 'modèle par défaut vide');
      assert.ok(descriptor.modelHint.length > 0, 'exemple de modèle vide');
      // Le défaut du fournisseur doit lui-même passer son propre test de forme,
      // sans quoi le panel s'avertirait lui-même dès l'installation.
      assert.ok(
        descriptor.nativeModel.test(descriptor.defaultModel),
        `le défaut « ${descriptor.defaultModel} » ne ressemble pas à un identifiant ${descriptor.label}`,
      );
    });

    check(`« ${provider} » a une fabrique`, () => {
      assert.equal(typeof getAiProviderFactory(provider), 'function');
    });
  }

  check('les descripteurs et la liste ne divergent pas', () => {
    assert.deepEqual(
      aiProviderDescriptors().map((descriptor) => descriptor.key),
      AI_PROVIDERS,
    );
  });

  check('un fournisseur inventé est rejeté', () => {
    assert.equal(isAiProvider('mistral'), false);
    assert.equal(isAiProvider(''), false);
    assert.equal(isAiProvider(null), false);
    assert.equal(isAiProvider('openrouter'), true);
  });
}

step('2. Le modèle par défaut suit le fournisseur');
{
  for (const provider of AI_PROVIDERS) {
    check(`${provider} → ${defaultAiModel(provider)}`, () => {
      const resolved = resolveAiConfig({
        settings: { provider, enabled: true },
        settingsApiKey: 'sk-test',
      });
      assert.equal(resolved.provider, provider);
      assert.equal(resolved.model, defaultAiModel(provider));
      assert.equal(resolved.modelSource, 'default');
    });
  }

  check('deux fournisseurs n’ont pas le même défaut', () => {
    const defaults = AI_PROVIDERS.map(defaultAiModel);
    assert.equal(new Set(defaults).size, defaults.length);
  });

  check('un modèle réglé à la main gagne sur le défaut', () => {
    const resolved = resolveAiConfig({
      settings: { provider: 'anthropic', model: 'claude-opus-4-5' },
      settingsApiKey: 'sk-test',
    });
    assert.equal(resolved.model, 'claude-opus-4-5');
    assert.equal(resolved.modelSource, 'settings');
  });

  check('un provider inconnu en base retombe sur OpenRouter, sans planter', () => {
    const resolved = resolveAiConfig({
      settings: { provider: 'skynet' },
      settingsApiKey: 'sk-test',
    });
    assert.equal(resolved.provider, 'openrouter');
  });
}

step('3. La variable d’environnement de repli est propre au fournisseur');
{
  const env = {
    OPENROUTER_API_KEY: 'sk-or-xxx',
    OPENROUTER_MODEL: 'openai/gpt-5',
  };

  check('OpenRouter lit OPENROUTER_API_KEY', () => {
    const resolved = resolveAiConfig({ settings: { provider: 'openrouter' }, env });
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.keySource, 'env');
    assert.equal(resolved.model, 'openai/gpt-5');
    assert.equal(resolved.modelSource, 'env');
  });

  for (const provider of ['openai', 'anthropic'] as const) {
    check(`${provider} ignore OPENROUTER_API_KEY — pas de clé, pas de génération`, () => {
      const resolved = resolveAiConfig({ settings: { provider }, env });
      assert.equal(resolved.enabled, false);
      assert.equal(resolved.keySource, 'none');
      assert.equal(resolved.apiKey, undefined);
      // Et surtout : il ne reprend pas non plus le modèle d'OpenRouter.
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
    const openai = resolveAiConfig({ settings: { provider: 'openai' }, env: full });
    assert.equal(openai.enabled, true);
    assert.equal(openai.apiKey, 'sk-oa-xxx');

    const anthropic = resolveAiConfig({ settings: { provider: 'anthropic' }, env: full });
    assert.equal(anthropic.apiKey, 'sk-ant-xxx');
    assert.equal(anthropic.model, 'claude-haiku-4-5');
  });

  check('la clé des paramètres prime sur celle de l’environnement', () => {
    const resolved = resolveAiConfig({
      settings: { provider: 'openrouter' },
      settingsApiKey: 'sk-settings',
      env,
    });
    assert.equal(resolved.apiKey, 'sk-settings');
    assert.equal(resolved.keySource, 'settings');
  });

  check('l’interrupteur coupe la génération même avec une clé', () => {
    const resolved = resolveAiConfig({
      settings: { provider: 'openrouter', enabled: false },
      settingsApiKey: 'sk-settings',
    });
    assert.equal(resolved.enabled, false);
    assert.equal(resolved.apiKey, 'sk-settings', 'la clé reste résolue, seule la génération est coupée');
  });

  check('l’URL de base n’est retenue que par les fournisseurs qui la déclarent', () => {
    const openai = resolveAiConfig({
      settings: { provider: 'openai', baseUrl: 'https://llm.interne/v1' },
      settingsApiKey: 'k',
    });
    assert.equal(openai.baseUrl, 'https://llm.interne/v1');

    const anthropic = resolveAiConfig({
      settings: { provider: 'anthropic', baseUrl: 'https://llm.interne/v1' },
      settingsApiKey: 'k',
    });
    assert.equal(anthropic.baseUrl, undefined, 'Anthropic ne déclare pas supportsBaseUrl');
  });
}

step('4. Un modèle incohérent avec le fournisseur est signalé');
{
  check('OpenRouter + « gpt-5.2 » → averti, et OpenAI est nommé', () => {
    const warning = aiModelMismatch('openrouter', 'gpt-5.2');
    assert.ok(warning, 'aucun avertissement');
    assert.match(warning, /OpenAI/);
  });

  check('Anthropic + « anthropic/claude-sonnet-4.5 » → averti, OpenRouter est nommé', () => {
    const warning = aiModelMismatch('anthropic', 'anthropic/claude-sonnet-4.5');
    assert.ok(warning);
    assert.match(warning, /OpenRouter/);
  });

  check('OpenAI + « claude-sonnet-4-5 » → averti, Anthropic est nommé', () => {
    const warning = aiModelMismatch('openai', 'claude-sonnet-4-5');
    assert.ok(warning);
    assert.match(warning, /Anthropic/);
  });

  check('un identifiant natif ne déclenche rien', () => {
    assert.equal(aiModelMismatch('openrouter', 'anthropic/claude-sonnet-4.5'), null);
    assert.equal(aiModelMismatch('openai', 'gpt-4.1'), null);
    assert.equal(aiModelMismatch('openai', 'o3-mini'), null);
    assert.equal(aiModelMismatch('anthropic', 'claude-opus-4-5'), null);
  });

  check('une URL de base personnalisée suspend l’avertissement', () => {
    assert.equal(
      aiModelMismatch('openai', 'mixtral-8x7b-instruct', { baseUrl: 'https://llm.interne/v1' }),
      null,
    );
    assert.ok(aiModelMismatch('openai', 'mixtral-8x7b-instruct'));
  });

  check('resolveAiConfig porte l’avertissement jusqu’à la route', () => {
    const resolved = resolveAiConfig({
      settings: { provider: 'anthropic', model: 'anthropic/claude-sonnet-4.5' },
      settingsApiKey: 'k',
    });
    assert.ok(resolved.modelWarning, 'aucun avertissement remonté');
  });
}

step('5. Les paramètres d’instance acceptent les trois fournisseurs');
{
  for (const provider of AI_PROVIDERS) {
    check(`« ${provider} » est une valeur valide`, () => {
      const parsed = aiSettingsSchema.parse({ provider, model: defaultAiModel(provider) });
      assert.equal(parsed.provider, provider);
    });
  }

  check('un fournisseur hors catalogue est refusé', () => {
    assert.equal(aiSettingsSchema.safeParse({ provider: 'skynet' }).success, false);
  });

  check('une URL de base bancale est refusée à l’entrée', () => {
    assert.equal(aiSettingsSchema.safeParse({ baseUrl: 'pas-une-url' }).success, false);
    assert.equal(aiSettingsSchema.safeParse({ baseUrl: '' }).success, true);
    assert.equal(aiSettingsSchema.safeParse({ baseUrl: 'https://llm/v1' }).success, true);
  });

  check('un PATCH partiel ne réinitialise pas le reste de la section IA', () => {
    const patch = appSettingsPatchSchema.parse({ ai: { provider: 'openai' } });
    assert.deepEqual(patch.ai, { provider: 'openai' });
    assert.equal('model' in (patch.ai ?? {}), false, 'le modèle serait écrasé par un défaut');
  });

  check('la température et le plafond de jetons restent bornés', () => {
    assert.equal(aiSettingsSchema.safeParse({ temperature: 3 }).success, false);
    assert.equal(aiSettingsSchema.safeParse({ maxTokens: 10 }).success, false);
    assert.equal(aiSettingsSchema.parse({}).temperature, DEFAULT_TEMPERATURE);
  });
}

step('6. createModel refuse sans clé, et construit avec');
{
  for (const provider of AI_PROVIDERS) {
    const descriptor = aiProviderDescriptor(provider);

    check(`« ${provider} » sans clé → MissingApiKeyError nommant la bonne variable`, () => {
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

    check(`« ${provider} » avec clé → un modèle, sans réseau`, () => {
      const configured = createModel({ provider, apiKey: 'sk-test-hors-ligne' });
      assert.equal(typeof configured.model, 'object');
      assert.ok(configured.model !== null);
    });
  }

  check('sans fournisseur précisé, on reste sur OpenRouter (compatibilité)', () => {
    assert.throws(
      () => createModel({ apiKey: undefined }),
      (error: unknown) => {
        assert.ok(error instanceof MissingApiKeyError);
        assert.equal(error.provider, 'openrouter');
        return true;
      },
    );
  });

  check('une URL de base est acceptée par OpenAI sans ouvrir de connexion', () => {
    const configured = createModel({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'mixtral-8x7b',
      baseUrl: 'https://llm.interne/v1',
    });
    assert.ok(configured.model);
  });
}

step('7. Le schéma envoyé au fournisseur, et ce que chacun sait en faire');
{
  // Constaté contre la vraie API OpenAI, avec une vraie clé :
  //   Invalid schema for response_format 'AppSpec': In context=('properties',
  //   'services','items','properties','source'), 'oneOf' is not permitted.
  // La cause est ici, et elle est structurelle : `source` est un
  // discriminatedUnion, que Zod traduit en `oneOf`.
  const jsonSchema = JSON.stringify(appSpecJsonSchema());

  check('le schéma de l’AppSpec contient bien un « oneOf »', () => {
    assert.ok(
      jsonSchema.includes('"oneOf"'),
      'plus de oneOf : si l’AppSpec a changé, ce garde-fou doit être revu',
    );
  });

  // Le mode strict exige aussi `additionalProperties: false` partout et toutes
  // les propriétés dans `required` ; l'AppSpec porte des `default` et des
  // bornes. Le faire entrer dans ce moule voudrait dire maintenir un schéma
  // appauvri en parallèle. On désactive le mode strict à la place.
  check('l’AppSpec porte des défauts et des bornes, incompatibles avec le mode strict', () => {
    assert.ok(/"default"/.test(jsonSchema) || /"minimum"/.test(jsonSchema), jsonSchema.slice(0, 200));
  });

  check('OpenAI reçoit strictJsonSchema: false', () => {
    const configured = createModel({ provider: 'openai', apiKey: 'sk-test' });
    assert.deepEqual(configured.callOptions, { openai: { strictJsonSchema: false } });
  });

  check('OpenRouter construit son modèle hors mode strict', () => {
    // Le réglage se pose à la construction du modèle : on vérifie qu'il est
    // bien parvenu au modèle, et pas seulement qu'on l'a écrit.
    const configured = createModel({ provider: 'openrouter', apiKey: 'sk-test' });
    const settings = (configured.model as unknown as { settings?: unknown }).settings;
    assert.deepEqual(settings, { structuredOutputs: { strict: false } }, JSON.stringify(settings));
  });

  check('Anthropic n’a aucune option à poser — il passe par l’appel d’outil', () => {
    const configured = createModel({ provider: 'anthropic', apiKey: 'sk-test' });
    assert.deepEqual(configured.callOptions, {});
  });

  check('chaque fournisseur rend un modèle ET ses options d’appel', () => {
    for (const provider of AI_PROVIDERS) {
      const configured = createModel({ provider, apiKey: 'sk-test' });
      assert.ok(configured.model, `${provider} : pas de modèle`);
      assert.equal(typeof configured.callOptions, 'object', `${provider} : pas d’options`);
    }
  });
}

step("8. Le message d’un fournisseur est nettoyé avant d’être relayé");
{
  const key = 'sk-sentinelle-verif-ia-0000000000000000';

  check('la clé exacte disparaît du message', () => {
    const cleaned = redactApiKey(`401 rejected key ${key}`, key);
    assert.ok(!cleaned.includes(key), cleaned);
    assert.match(cleaned, /clé masquée/);
  });

  // Constaté en vrai contre l'API OpenAI : le fournisseur recopie les huit
  // premiers et les quatre derniers caractères de la clé. Un masque qui laisse
  // douze caractères en clair n'est pas un masque.
  check('la forme masquée par OpenAI disparaît aussi', () => {
    const masked = 'Incorrect API key provided: sk-senti***************************0000. You can find…';
    const cleaned = redactApiKey(masked, key);
    assert.ok(!cleaned.includes('sk-senti'), cleaned);
    assert.match(cleaned, /clé masquée/);
  });

  check('les formes des autres fournisseurs sont couvertes', () => {
    for (const sample of ['sk-ant-api03-AbCdEf', 'sk-or-v1-0123456789', 'gsk_ABCDEFGHIJ']) {
      assert.ok(!redactApiKey(`erreur : ${sample}`).includes(sample), sample);
    }
  });

  check('un message sans clé traverse intact', () => {
    const message = "Le modèle n'a pas répondu dans le délai imparti";
    assert.equal(redactApiKey(message, key), message);
  });
}

step('9. Le prompt système guide vers une application multi-services');
{
  const prompt = generateAppSpecPrompt();
  info(`${prompt.length} caractères`);

  check('la consigne « application sur étagère + sa base » y figure', () => {
    assert.match(prompt, /vient avec sa base/i);
    assert.match(prompt, /GLPI/);
    assert.match(prompt, /dependsOn/);
  });

  check('la règle « aucun secret inventé » est explicite', () => {
    assert.match(prompt, /n'inventes?\s+\*\*jamais\*\*\s+de valeur de secret/i);
    assert.match(prompt, /changeme/);
  });

  check('aucune marque de fixture ne survit', () => {
    assert.ok(!prompt.includes('{{FIXTURE:'));
  });

  // Le point qui compte : un exemple faux dans le prompt apprend au modèle à
  // produire du faux. Chaque bloc JSON est donc confronté au vrai schéma.
  //
  // Tous les blocs ne sont pas des specs entières : certains sont des
  // **extraits** — deux services montrés côte à côte pour illustrer l'alias de
  // secret, sans le bruit des sources et des sondes. Les confondre avec des
  // specs faisait échouer ce contrôle sur un bloc parfaitement légitime, et la
  // seule manière de le faire taire aurait été de gonfler l'extrait jusqu'à
  // noyer ce qu'il montre.
  //
  // La distinction se lit dans la forme, pas dans une annotation qu'on
  // oublierait de poser : une spec est un objet qui porte `name` et `services`.
  // Un extrait n'est dispensé que de la validation métier, jamais de la
  // syntaxe — du JSON illisible dans un prompt apprend au modèle à en écrire.
  const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? '');
  info(`${blocks.length} blocs JSON dans le prompt`);

  const parsed = blocks.map((block, index) => {
    try {
      return { index, value: JSON.parse(block) as unknown, readable: true };
    } catch {
      return { index, value: undefined, readable: false };
    }
  });

  check('tous les blocs JSON du prompt sont analysables', () => {
    const broken = parsed.filter((block) => !block.readable).map((block) => `#${block.index + 1}`);
    assert.equal(broken.length, 0, `bloc(s) illisible(s) : ${broken.join(', ')}`);
  });

  const isSpec = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && 'name' in value && 'services' in value;

  const specs = parsed.filter((block) => block.readable && isSpec(block.value));
  info(`${specs.length} spec(s) entière(s), ${parsed.length - specs.length} extrait(s)`);

  const verdicts = specs.map((block) => safeParseAppSpec(block.value).success);

  const valid = verdicts.filter(Boolean).length;
  const invalid = verdicts.length - valid;

  check('au moins trois exemples valides', () => {
    assert.ok(valid >= 3, `${valid} exemple(s) valide(s) seulement`);
  });

  check('exactement deux contre-exemples invalides — pas un de plus', () => {
    // Les deux voulus : `invalid.json`, et la spec de refus `{ services: [] }`.
    // Un troisième signifierait qu'un exemple censé être correct ne l'est pas.
    assert.equal(
      invalid,
      2,
      `${invalid} bloc(s) invalide(s) : ` +
        specs
          .filter((_, position) => !verdicts[position])
          .map((block) => `#${block.index + 1}`)
          .join(', '),
    );
  });

  check('l’exemple sur étagère relie bien ses deux services', () => {
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
    assert.ok(wordpress, 'exemple « wordpress » introuvable dans le prompt');

    const parsed = safeParseAppSpec(wordpress);
    assert.ok(parsed.success, 'l’exemple ne passe pas appSpecSchema');
    const spec = parsed.data;

    assert.equal(spec.services.length, 2, 'l’application et sa base');
    const app = spec.services.find((service) => service.exposed);
    const db = spec.services.find((service) => !service.exposed);
    assert.ok(app && db);
    assert.deepEqual(app.dependsOn, [db.name], 'l’application dépend de sa base');
    assert.ok(
      Object.values(app.env).some((value) => value.startsWith(db.name)),
      'l’application adresse la base par le nom du service',
    );
    assert.ok(db.volumes.length > 0, 'la base n’a pas de volume');
    assert.ok(db.healthcheck.port !== undefined, 'la base est sondée sur son port');
    assert.ok(app.secrets.length > 0 && db.secrets.length > 0, 'mots de passe non déclarés');
    // Et surtout : aucune valeur de secret dans `env`.
    for (const service of spec.services) {
      for (const [key, value] of Object.entries(service.env)) {
        assert.ok(
          !/PASSWORD|SECRET|TOKEN|API_KEY/.test(key),
          `« ${key}=${value} » : un secret a fui dans env`,
        );
      }
    }
  });
}

step('Bilan');
if (failures === 0) {
  process.stdout.write(`  ${green('✓')} ${checks} vérifications, aucune défaillance\n\n`);
} else {
  process.stdout.write(`  ${red('✗')} ${failures} défaillance(s) sur ${checks} vérifications\n\n`);
  process.exit(1);
}
