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
      action: z.enum(['restart', 'stream.started', 'stream.stopped', 'stream.error']),
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
 * Dernier état connu de l'application, retenu **hors du flux**.
 *
 * Un `publish` Redis ne se rejoue pas : qui s'abonne après coup n'a rien. Or le
 * flux est partagé — un seul job pour tous les spectateurs d'un déploiement —
 * donc le deuxième onglet, le rechargement de page et la reconnexion après
 * coupure rejoignent tous un flux **déjà ouvert**, dont l'instantané d'état est
 * passé depuis longtemps. C'est exactement ce qui faisait dire à l'écran
 * « aucun conteneur rapporté par la cible » pendant que les logs d'un conteneur
 * défilaient : l'état n'avait jamais été reçu, pas relevé vide.
 *
 * D'où cette clé : le worker y dépose chaque relevé, la route SSE la relit à la
 * connexion et la sert au nouveau venu avant même la première ligne de log. Le
 * relevé porte son `checkedAt` — l'écran dit donc son âge, il ne le fait pas
 * passer pour frais.
 */
export function appStatusKey(deploymentId: string): string {
  return `app-logs:status:${deploymentId}`;
}

/**
 * Durée de vie du dernier état connu. Large devant la cadence de relevé : la
 * clé doit survivre à un flux qui se rouvre (le temps qu'un onglet se
 * reconnecte), pas à une nuit entière. Au-delà, mieux vaut ne rien montrer que
 * de montrer un inventaire d'hier.
 */
export const STATUS_TTL_SECONDS = 300;

/**
 * Cadence de re-relevé de l'état pendant qu'un flux est ouvert.
 *
 * L'instantané d'ouverture ne suffit pas : un flux vit jusqu'à trente minutes,
 * pendant lesquelles un conteneur peut sortir, redémarrer en boucle ou devenir
 * malsain sans que la carte d'état bouge d'un pixel. Vingt secondes, parce que
 * le relevé emprunte la session SSH **déjà ouverte** pour les logs — pas de
 * connexion à établir, un `compose ps` de quelques centaines de millisecondes.
 * C'est le seul coût récurrent qu'on impose à la machine cible, et il n'existe
 * que tant que quelqu'un regarde l'écran.
 */
export const STATUS_REFRESH_MS = 20_000;

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
