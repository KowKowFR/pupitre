import { aiProviderDescriptor, generateAppSpecPrompt, resolveAiConfig } from '@pupitre/core/ai';
import { getAppSettings, pingDb } from '@pupitre/db';
import { NextResponse } from 'next/server';
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
 *
 * `keySource` dit **d'où** vient la clé retenue, jamais ce qu'elle contient : ni
 * sa valeur, ni ses derniers caractères, ni sa longueur. C'est l'information
 * dont on a besoin pour diagnostiquer « je l'ai posée dans l'écran mais le panel
 * lit encore l'environnement », et c'est la seule qu'une sonde publique peut
 * donner sans devenir un oracle sur un secret.
 */
type AiState = {
  enabled: boolean;
  provider: string;
  model: string;
  /** `settings` : clé en base ; `env` : variable d'environnement ; `none` : aucune. */
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
 * Marqueur de présence — **jamais** une clé.
 *
 * `resolveAiConfig()` ne demande pas « une clé est-elle configurée ? » mais la
 * clé elle-même : c'est ce qui lui permet de servir aussi le chemin d'appel au
 * fournisseur. La sonde, elle, n'a rien à déchiffrer et rien à envoyer à
 * personne — elle passe donc ce marqueur à la place et ne relit jamais
 * `apiKey` en retour.
 *
 * Réutiliser la fonction plutôt que recopier sa règle de priorité
 * (paramètres > environnement, et le drapeau `enabled` qui coupe tout) est ce
 * qui garantit que la sonde et l'écran de génération répondent la même chose.
 * C'est précisément la divergence qu'on corrige : la sonde ne regardait que
 * `OPENROUTER_API_KEY` et annonçait « IA désactivée » à une instance qui
 * générait très bien depuis OpenAI avec une clé en base.
 */
// i18n-ignore — marqueur interne passé à `resolveAiConfig()` en guise de clé
// factice, et jamais relu. Ce n'est pas une phrase, c'est une sentinelle.
const KEY_PRESENT = '(clé enregistrée en base)';

async function probe(name: string, run: () => Promise<unknown>): Promise<ComponentState> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    logger.error({ component: name, error: error instanceof Error ? error.message : error }, 'sonde en échec');
    return 'error';
  }
}

/**
 * Coût par sonde : **une** lecture de `app_settings`, servie par le cache
 * mémoire de cinq secondes de `getAppSettings()`. Le healthcheck du conteneur
 * `panel` interroge cette route toutes les dix secondes : au pire une requête
 * sur une ligne unique par sonde, la même que celle que fait déjà chaque rendu
 * de page. Aucun appel au fournisseur d'IA, et aucun déchiffrement de plus —
 * `getAiApiKey()` n'est jamais appelé ici.
 *
 * Une base injoignable ne fait pas échouer la sonde IA : on retombe sur
 * l'environnement seul, et c'est `db` qui porte la panne.
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
      'paramètres IA illisibles, repli sur l’environnement',
    );
  }

  const config = resolveAiConfig({
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
      'prompt système introuvable',
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
