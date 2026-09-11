import { z } from 'zod';

/**
 * Métriques d'hôte — ce que fait la machine, pas ce qu'elle porte.
 *
 * **Pourquoi ce n'est pas dans le `DeploymentDriver`.** Charge, mémoire,
 * disque, uptime, noyau : rien de tout cela ne dépend du runtime. Une machine
 * Linux est une machine Linux, qu'elle porte Docker ou K3s ; `/proc/loadavg`
 * ne connaît ni l'un ni l'autre. Les mettre dans les drivers obligerait à les
 * écrire deux fois et à les maintenir en double, pour un résultat qui doit être
 * identique des deux côtés. Leur place est à côté du preflight, qui inspecte
 * déjà l'hôte de la même façon — d'où la symétrie de ce fichier avec
 * `preflight.ts` : les *types* ici, la sonde SSH dans `ssh/host-metrics.ts`,
 * pour que le panel Next puisse lire les uns sans tirer `ssh2` dans son graphe.
 *
 * **`null` veut dire « je ne sais pas ».** Aucune métrique n'a de valeur de
 * repli : un zéro affiché à la place d'un disque non mesuré ferait croire à un
 * disque vide, et un 100 % à un disque plein. Chaque relevé est indépendant —
 * un `nproc` absent laisse la charge lisible, il ne fait pas échouer le reste.
 */

/** Un relevé élémentaire, et ce qu'il a coûté. Miroir de `PreflightCheck`. */
export const hostProbeSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(['success', 'failed']),
  durationMs: z.number().int().nonnegative(),
  detail: z.string().nullable(),
  error: z.string().nullable(),
});
export type HostProbe = z.infer<typeof hostProbeSchema>;

/**
 * Charge moyenne, rapportée au nombre de cœurs.
 *
 * Une charge de 4 ne dit rien tant qu'on ne sait pas sur combien de cœurs :
 * c'est confortable sur 16, c'est le double de la capacité sur 2. `perCore` est
 * la seule valeur réellement comparable d'une machine à l'autre — elle reste
 * `null` quand `nproc` est absent, plutôt que de supposer un cœur.
 */
export const hostLoadSchema = z.object({
  one: z.number().nonnegative(),
  five: z.number().nonnegative(),
  fifteen: z.number().nonnegative(),
  cores: z.number().int().positive().nullable(),
  /** `one / cores`, ou `null` si le nombre de cœurs est inconnu. */
  perCore: z.number().nonnegative().nullable(),
});
export type HostLoad = z.infer<typeof hostLoadSchema>;

/**
 * Mémoire, en kibioctets tels que `/proc/meminfo` les donne.
 *
 * `MemAvailable` et non `MemFree` : sous Linux, la mémoire « libre » est de la
 * mémoire gaspillée — le cache de pages l'occupe et la rend au premier
 * demandeur. Un panel qui afficherait `MemFree` annoncerait une machine
 * saturée sur un serveur parfaitement à l'aise.
 */
export const hostMemorySchema = z.object({
  totalKb: z.number().int().nonnegative(),
  availableKb: z.number().int().nonnegative(),
  usedKb: z.number().int().nonnegative(),
  usedPercent: z.number().min(0).max(100),
});
export type HostMemory = z.infer<typeof hostMemorySchema>;

/**
 * Disque de la partition qui **porte les déploiements**, pas `/`.
 *
 * Sur une machine où `/opt` est un volume séparé, mesurer `/` répondrait à côté
 * de la question : c'est la partition sur laquelle le driver écrit qui décide
 * si un déploiement passe. `path` dit ce qui a réellement été mesuré.
 */
export const hostDiskSchema = z.object({
  /** Chemin effectivement mesuré — l'ancêtre existant le plus proche de la racine du driver. */
  path: z.string().min(1),
  filesystem: z.string().min(1),
  sizeKb: z.number().int().nonnegative(),
  usedKb: z.number().int().nonnegative(),
  availableKb: z.number().int().nonnegative(),
  usePercent: z.number().min(0).max(100),
  mountedOn: z.string().min(1),
});
export type HostDisk = z.infer<typeof hostDiskSchema>;

/** Identité du système. Chaque champ est indépendamment inconnu. */
export const hostOsSchema = z.object({
  kernel: z.string().nullable(),
  name: z.string().nullable(),
  version: z.string().nullable(),
  prettyName: z.string().nullable(),
});
export type HostOs = z.infer<typeof hostOsSchema>;

/**
 * Un relevé complet, vrai à la seconde où il est pris.
 *
 * Il ne se stocke pas : il voyage par la valeur de retour du job. Le mettre en
 * base demanderait une table, une migration et une politique de fraîcheur pour
 * une donnée qui n'a pas d'histoire — la charge d'il y a une heure n'apprend
 * rien à personne.
 */
export const hostMetricsSchema = z.object({
  targetId: z.string().uuid(),
  checkedAt: z.string(),
  reachable: z.boolean(),
  /** Temps d'établissement de la session SSH. `null` si elle n'a pas abouti. */
  latencyMs: z.number().int().nonnegative().nullable(),
  /** Renseigné uniquement quand la machine est injoignable. */
  error: z.string().nullable(),
  load: hostLoadSchema.nullable(),
  memory: hostMemorySchema.nullable(),
  disk: hostDiskSchema.nullable(),
  uptimeSeconds: z.number().nonnegative().nullable(),
  os: hostOsSchema,
  probes: z.array(hostProbeSchema),
});
export type HostMetrics = z.infer<typeof hostMetricsSchema>;

/** Le relevé d'une machine qu'on n'a pas pu joindre. Aucune métrique, une raison. */
export function unreachableHostMetrics(
  targetId: string,
  error: string,
  checkedAt = new Date().toISOString(),
  probes: HostProbe[] = [],
): HostMetrics {
  return {
    targetId,
    checkedAt,
    reachable: false,
    latencyMs: null,
    error,
    load: null,
    memory: null,
    disk: null,
    uptimeSeconds: null,
    os: { kernel: null, name: null, version: null, prettyName: null },
    probes,
  };
}
