import { aiProviderDescriptor, generateAppSpecPrompt, resolveAiConfig } from '@pupitre/core/ai';
import { getAppSettings, pingDb } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getRedis } from '@/lib/redis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ComponentState = 'ok' | 'error';

/**
 * The state of AI generation.
 *
 * `prompt` deserves to be here, and not only in the generation route: the system
 * prompt is a **file**, and a file can be missing from a Docker image without
 * anything saying so. Loading it from the health probe makes fail loudly what
 * would otherwise only fail at the first user — and allows checking it in the
 * container, not only locally.
 *
 * `enabled: false` (no key) is not an outage: the rest of the panel works.
 *
 * `keySource` says **where** the chosen key comes from, never what it contains:
 * neither its value, nor its last characters, nor its length. It is the
 * information needed to diagnose "I set it in the screen but the panel still
 * reads the environment", and it is the only one a public probe can give without
 * becoming an oracle on a secret.
 */
type AiState = {
  enabled: boolean;
  provider: string;
  model: string;
  /** `settings`: key in the database; `env`: environment variable; `none`: none. */
  keySource: 'settings' | 'env' | 'none';
  prompt: ComponentState;
  promptBytes: number | null;
};

type HealthPayload = {
  status: 'ok' | 'degraded';
  db: ComponentState;
  redis: ComponentState;
  ai: AiState;
  uptimeSeconds: number;
  checkedAt: string;
};

/**
 * A presence marker — **never** a key.
 *
 * `resolveAiConfig()` does not ask "is a key configured?" but for the key itself:
 * that is what lets it also serve the path that calls the provider. The probe,
 * for its part, has nothing to decrypt and nothing to send to anyone — so it
 * passes this marker instead and never reads `apiKey` back.
 *
 * Reusing the function rather than copying its priority rule (settings >
 * environment, and the `enabled` flag that cuts everything) is what guarantees
 * that the probe and the generation screen answer the same thing. It is precisely
 * the divergence being fixed: the probe only looked at `OPENROUTER_API_KEY` and
 * announced "AI disabled" to an instance that generated just fine from OpenAI
 * with a key in the database.
 */
// i18n-ignore — an internal marker passed to `resolveAiConfig()` as a dummy key,
// and never read back. It is not a sentence, it is a sentinel.
const KEY_PRESENT = '(key stored in the database)';

async function probe(name: string, run: () => Promise<unknown>): Promise<ComponentState> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    logger.error({ component: name, error: error instanceof Error ? error.message : error }, 'probe failed');
    return 'error';
  }
}

/**
 * Cost per probe: **one** read of `app_settings`, served by `getAppSettings()`'s
 * five-second memory cache. The `panel` container's healthcheck queries this
 * route every ten seconds: at worst one query on a single row per probe, the same
 * that each page render already makes. No call to the AI provider, and no extra
 * decryption — `getAiApiKey()` is never called here.
 *
 * An unreachable database does not fail the AI probe: we fall back on the
 * environment alone, and it is `db` that carries the outage.
 */
async function aiState(): Promise<AiState> {
  let settings: Parameters<typeof resolveAiConfig>[0]['settings'] = null;
  let keyInDatabase = false;
  try {
    const record = await getAppSettings();
    settings = record.settings.ai;
    keyInDatabase = record.aiApiKeyConfigured;
  } catch (error) {
    logger.error(
      { component: 'ai-settings', error: error instanceof Error ? error.message : error },
      'AI settings unreadable, falling back on the environment',
    );
  }

  const config = resolveAiConfig({
    // A probe for the monitoring tools, not a screen: its warnings are in English.
    language: 'en',
    settings,
    settingsApiKey: keyInDatabase ? KEY_PRESENT : null,
    env: process.env,
  });

  const base = {
    enabled: config.enabled,
    provider: aiProviderDescriptor(config.provider).key,
    model: config.model,
    keySource: config.keySource,
  } satisfies Omit<AiState, 'prompt' | 'promptBytes'>;

  try {
    const prompt = generateAppSpecPrompt();
    return { ...base, prompt: 'ok', promptBytes: prompt.length };
  } catch (error) {
    logger.error(
      { component: 'ai-prompt', error: error instanceof Error ? error.message : error },
      'system prompt not found',
    );
    return { ...base, prompt: 'error', promptBytes: null };
  }
}

export async function GET(): Promise<NextResponse<HealthPayload>> {
  const [db, redis, ai] = await Promise.all([
    probe('postgres', () => pingDb()),
    probe('redis', async () => getRedis().ping()),
    aiState(),
  ]);

  // A missing prompt only degrades the health if generation is enabled: on a panel
  // without a key, the file serves nobody.
  const aiOk = !ai.enabled || ai.prompt === 'ok';
  const status: HealthPayload['status'] = db === 'ok' && redis === 'ok' && aiOk ? 'ok' : 'degraded';

  return NextResponse.json(
    {
      status,
      db,
      redis,
      ai,
      uptimeSeconds: Math.round(process.uptime()),
      checkedAt: new Date().toISOString(),
    },
    { status: status === 'ok' ? 200 : 503 },
  );
}
