import { DEFAULT_OPENROUTER_MODEL, generateAppSpecPrompt } from '@tp/core/ai';
import { pingDb } from '@tp/db';
import { NextResponse } from 'next/server';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getRedis } from '@/lib/redis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ComponentState = 'ok' | 'error';

/**
 * État de la génération par IA.
 *
 * `prompt` mérite d'être ici, et pas seulement dans la route de génération : le
 * prompt système est un **fichier**, et un fichier peut manquer d'une image
 * Docker sans que rien ne le dise. Le charger depuis la sonde de santé fait
 * échouer bruyamment ce qui, sinon, n'échouerait qu'au premier utilisateur —
 * et permet de le vérifier dans le conteneur, pas seulement en local.
 *
 * `enabled: false` (pas de clé) n'est pas une panne : le reste du panel marche.
 */
type AiState = {
  enabled: boolean;
  model: string;
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

async function probe(name: string, run: () => Promise<unknown>): Promise<ComponentState> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    logger.error({ component: name, error: error instanceof Error ? error.message : error }, 'sonde en échec');
    return 'error';
  }
}

function aiState(): AiState {
  let enabled = false;
  let model = DEFAULT_OPENROUTER_MODEL;
  try {
    const env = getEnv();
    enabled = Boolean(env.OPENROUTER_API_KEY);
    model = env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL;
  } catch {
    // Environnement incomplet : `db`/`redis` le diront déjà.
  }

  try {
    const prompt = generateAppSpecPrompt();
    return { enabled, model, prompt: 'ok', promptBytes: prompt.length };
  } catch (error) {
    logger.error(
      { component: 'ai-prompt', error: error instanceof Error ? error.message : error },
      'prompt système introuvable',
    );
    return { enabled, model, prompt: 'error', promptBytes: null };
  }
}

export async function GET(): Promise<NextResponse<HealthPayload>> {
  const [db, redis] = await Promise.all([
    probe('postgres', () => pingDb()),
    probe('redis', async () => getRedis().ping()),
  ]);

  const ai = aiState();

  // Un prompt introuvable ne dégrade la santé que si la génération est activée :
  // sur un panel sans clé, le fichier ne sert à personne.
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
