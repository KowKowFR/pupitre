import { z } from 'zod';

/**
 * Supervision des applications en marche.
 *
 * Distincte du pipeline : celui-ci raconte un déploiement, celle-ci raconte ce
 * qui tourne *maintenant*. Les deux ont leurs propres canaux Redis et leurs
 * propres flux SSE — mélanger les deux rendrait illisible autant l'un que l'autre.
 */

export const serviceStateSchema = z.enum([
  'running',
  'restarting',
  'exited',
  'paused',
  'created',
  'unknown',
]);
export type ServiceState = z.infer<typeof serviceStateSchema>;

/** État d'un service tel que le runtime le rapporte. */
export const serviceStatusSchema = z.object({
  name: z.string().min(1),
  state: serviceStateSchema,
  /** Santé rapportée par la sonde du conteneur, quand il en déclare une. */
  health: z.enum(['healthy', 'unhealthy', 'starting', 'none']).default('none'),
  /** Depuis quand, tel que l'affiche le runtime — « Up 2 hours ». */
  since: z.string().nullable().default(null),
  image: z.string().nullable().default(null),
  ports: z.array(z.string()).default([]),
});
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const appStatusSchema = z.object({
  services: z.array(serviceStatusSchema),
  checkedAt: z.string(),
});
export type AppStatus = z.infer<typeof appStatusSchema>;

/** Une ligne de log applicatif, telle que le runtime la produit. */
export const appLogLineSchema = z.object({
  ts: z.string(),
  /** Service émetteur, quand le runtime le préfixe. */
  service: z.string().nullable().default(null),
  line: z.string(),
});
export type AppLogLine = z.infer<typeof appLogLineSchema>;

export const appLogMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('log'), payload: appLogLineSchema }),
  z.object({ kind: z.literal('status'), payload: appStatusSchema }),
  z.object({
    kind: z.literal('lifecycle'),
    payload: z.object({
      ts: z.string(),
      // `stop` et `start` s'ajoutent à `restart` : ce sont les mêmes gestes
      // d'exploitation, ils se racontent dans le même flux et devant le même
      // spectateur. Un consommateur qui ne les connaît pas les ignore — la
      // console filtre déjà sur l'action qu'elle sait afficher.
      action: z.enum([
        'restart',
        'stop',
        'start',
        'stream.started',
        'stream.stopped',
        'stream.error',
      ]),
      detail: z.string().nullable().default(null),
    }),
  }),
]);
export type AppLogMessage = z.infer<typeof appLogMessageSchema>;

/** Canal Redis des logs applicatifs d'un déploiement. */
export function appLogChannel(deploymentId: string): string {
  return `app-logs:${deploymentId}`;
}

/**
 * Clé de présence d'un spectateur, à durée de vie courte.
 *
 * C'est elle qui commande l'arrêt du flux : la route SSE la rafraîchit tant
 * qu'un client écoute, le worker la relit régulièrement et coupe la session SSH
 * dès qu'elle a disparu. Un onglet fermé brutalement n'émet rien — mais la clé
 * expire, et le flux s'arrête de lui-même. Plusieurs spectateurs rafraîchissent
 * la même clé : le dernier parti éteint la lumière.
 */
export function appLogWatchKey(deploymentId: string): string {
  return `app-logs:watch:${deploymentId}`;
}

/** Durée de vie de la clé de présence. */
export const WATCH_TTL_SECONDS = 25;

/** Cadence de rafraîchissement côté panel. Doit rester bien sous le TTL. */
export const WATCH_REFRESH_MS = 8_000;

/** Cadence de relecture côté worker. */
export const WATCH_POLL_MS = 5_000;

/**
 * Durée maximale d'un flux, quoi qu'il arrive. Un slot de worker ne doit pas
 * rester pris indéfiniment parce qu'un onglet est resté ouvert tout un week-end.
 * Le panel redemande un flux à la reconnexion : la coupure est invisible.
 */
export const STREAM_MAX_MS = 30 * 60_000;

/** Un déploiement dont on peut suivre et redémarrer l'application. */
export function isSupervisable(status: string): boolean {
  return status === 'success' || status === 'rolled_back';
}
