import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  /** Validée en profondeur par `assertMasterKey()` au démarrage. */
  MASTER_KEY: z.string().min(32, 'MASTER_KEY doit faire au moins 32 octets'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Spectateurs de logs simultanés. Chacun tient une session SSH ouverte. */
  SUPERVISION_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  WORKER_ID: z.string().min(1).default('worker-1'),
  /**
   * Plages internes que les sondes de supervision ont le droit d'atteindre,
   * en CIDR séparés par des virgules — ex. `10.0.0.0/8,192.168.1.0/24`.
   *
   * Vide par défaut : seules les adresses **publiques** sont sondables. C'est la
   * garde SSRF, et elle se lève ici et nulle part ailleurs — pas depuis
   * l'interface, pas avec une permission. Le raisonnement complet est dans
   * `packages/core/src/monitoring.ts`.
   *
   * Le lien-local (`169.254.0.0/16`, qui porte les services de métadonnées), le
   * multicast et le réservé restent refusés même s'ils sont listés ici.
   */
  MONITOR_ALLOWED_CIDRS: z.string().default(''),
  /**
   * Point d'entrée CDP du navigateur de capture — `http://capture-browser:9222`.
   *
   * **Vide par défaut, et c'est l'interrupteur de la fonctionnalité.** Sans
   * cette variable, aucune capture n'est tentée, aucun mandataire de sortie
   * n'est ouvert, et rien n'échoue : une instance qui ne veut pas de captures
   * ne démarre pas un navigateur et n'en paie pas le prix. Le conteneur vit
   * derrière le profil Compose `capture`, comme `mailpit` et `ssh-target`.
   *
   * ⚠ Une capture montre la page telle qu'un visiteur anonyme la voit. Le
   * navigateur ne porte aucune session — contexte neuf à chaque fois — mais une
   * URL supervisée qui porte elle-même un jeton (`?token=…`) fera apparaître du
   * contenu privé dans l'image. Les images ne sont servies qu'à `monitor:read`
   * et ne partent dans aucune alerte ; le raisonnement complet est dans
   * `packages/core/src/monitors/capture.ts`.
   */
  MONITOR_CAPTURE_CDP_URL: z.string().default(''),
  /**
   * Port du mandataire de sortie du navigateur, ouvert par le worker et
   * seulement quand la capture est active.
   *
   * Le navigateur est enfermé sur un réseau Compose **interne** : sa seule
   * route mène au worker. Tout ce qu'il charge passe donc par ce port, et par
   * la même garde SSRF que les sondes. Le raisonnement — et la mesure qui a
   * montré qu'un simple réseau séparé ne suffisait pas — est dans
   * `packages/core/src/capture/egress.ts`.
   */
  MONITOR_CAPTURE_EGRESS_PORT: z.coerce.number().int().min(1).max(65_535).default(8383),
  /**
   * Sauvegardes menées en même temps. Une par défaut : ni la cible ni la
   * destination n'apprécient dix archives à la fois, et la nuit est longue.
   */
  BACKUP_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  /**
   * Où une restauration dépose ses fichiers le temps de les vérifier, avant de
   * les appliquer. Il y faut la place de la plus grosse archive.
   */
  BACKUP_TMP_DIR: z.string().min(1).default('/tmp'),
  /** Les outils PostgreSQL de la sauvegarde du panel — dans l'image Docker du worker. */
  PG_DUMP_PATH: z.string().min(1).default('pg_dump'),
  PG_RESTORE_PATH: z.string().min(1).default('pg_restore'),
  /** Racine où le driver dépose ses artefacts sur les cibles. */
  DRIVER_ROOT_PATH: z.string().min(1).default('/opt/bootstrap'),
  /**
   * Plage de ports publiables, au format `min-max`. Utile quand un pare-feu
   * n'ouvre qu'une partie de la plage par défaut (30000-32767).
   */
  DRIVER_PORT_RANGE: z
    .preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .regex(/^\d+-\d+$/, 'format attendu : min-max')
        .optional(),
    )
    .transform((value) => {
      if (!value) return undefined;
      const [min, max] = value.split('-').map(Number);
      return { min: min ?? 30_000, max: max ?? 32_767 };
    }),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error(
    '[worker] configuration invalide :',
    JSON.stringify(z.flattenError(parsed.error).fieldErrors, null, 2),
  );
  process.exit(1);
}

export const env = parsed.data;
