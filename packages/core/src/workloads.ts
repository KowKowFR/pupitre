import { z } from 'zod';
import { serviceStateSchema } from './supervision.js';

/**
 * Charges qui tournent sur une machine cible.
 *
 * « Charge » et pas « conteneur » : une cible peut être en K3s, où ce qui tourne
 * est un pod piloté par un Deployment. Le panel peut écrire « conteneur » dans
 * son interface quand la cible est en Docker — le code, lui, reste neutre, et
 * aucun appelant ne teste jamais le runtime pour savoir quoi faire.
 *
 * Distinct de `supervision.ts` : celle-ci raconte les services **d'un
 * déploiement du panel**, celui-ci raconte **tout ce qui tourne sur la
 * machine**, panel compris ou non. Le champ `managed` est exactement la
 * frontière entre les deux.
 */

/**
 * Structurellement identique à `RuntimeKind` (`drivers/types.ts`), et
 * volontairement redéclaré : ce module est réexporté par `index.ts`, que le
 * panel Next importe. Importer les drivers d'ici tirerait `ssh2` dans son
 * graphe de dépendances, ce que l'architecture interdit.
 */
export const workloadRuntimeSchema = z.enum(['docker', 'k3s']);
export type WorkloadRuntime = z.infer<typeof workloadRuntimeSchema>;

/**
 * Désignation d'une charge, telle qu'on la passe d'un écran à un job puis à un
 * driver.
 *
 * `id` est une **poignée opaque** : seul le driver du runtime nommé sait la
 * produire et la relire. Le panel ne l'interprète jamais — c'est ce qui permet
 * d'ajouter un troisième runtime sans toucher une ligne d'API.
 */
export const workloadRefSchema = z.object({
  runtime: workloadRuntimeSchema,
  id: z.string().min(1).max(300),
});
export type WorkloadRef = z.infer<typeof workloadRefSchema>;

/**
 * Forme transportable d'une référence, pour un segment d'URL.
 *
 * Le `:` est licite dans un segment de chemin, absent d'un identifiant Docker
 * (hexadécimal) comme d'un nom Kubernetes (DNS-1123). Attention en revanche à
 * ne jamais réutiliser cette chaîne comme identifiant de tâche BullMQ :
 * `Queue.add()` refuse un « Custom Id » contenant un `:`.
 */
export function encodeWorkloadRef(ref: WorkloadRef): string {
  return `${ref.runtime}:${ref.id}`;
}

export function decodeWorkloadRef(raw: string): WorkloadRef | null {
  const separator = raw.indexOf(':');
  if (separator <= 0) return null;

  const parsed = workloadRefSchema.safeParse({
    runtime: raw.slice(0, separator),
    id: raw.slice(separator + 1),
  });
  return parsed.success ? parsed.data : null;
}

export const workloadSchema = z.object({
  runtime: workloadRuntimeSchema,
  /** Poignée opaque, produite et relue par le seul driver de ce runtime. */
  id: z.string().min(1),
  name: z.string().min(1),
  /**
   * Nom que **ce runtime** donne à ce genre de charge : « conteneur »,
   * « deployment », « pod ». Purement descriptif, destiné à l'affichage — rien
   * ne s'en sert pour décider quoi que ce soit.
   */
  kind: z.string().min(1),
  /** Regroupement propre au runtime : projet Compose, namespace Kubernetes. */
  scope: z.string().nullable().default(null),
  image: z.string().nullable().default(null),
  /** Même vocabulaire que la supervision : pas de second jeu d'états. */
  state: serviceStateSchema,
  health: z.enum(['healthy', 'unhealthy', 'starting', 'none']).default('none'),
  createdAt: z.string().nullable().default(null),
  /** Formulation du runtime : « Up 2 hours », « 2/2 prêts ». */
  since: z.string().nullable().default(null),
  /** Ports publiés, tels que le runtime les formule. */
  ports: z.array(z.string()).default([]),
  /**
   * Le panel est-il responsable du cycle de vie de cette charge ?
   *
   * Une charge du panel a déjà ses gestes — redéploiement, redémarrage,
   * destruction, rollback — et une ligne en base qui les enregistre. La
   * supprimer par cet écran laisserait la base persuadée que l'application
   * tourne encore, son port réservé pour rien.
   */
  managed: z.boolean(),
  /** Slug de l'application du panel, quand `managed` est vrai. */
  managedApp: z.string().nullable().default(null),
});
export type Workload = z.infer<typeof workloadSchema>;

export const workloadListSchema = z.object({
  targetId: z.string().uuid(),
  checkedAt: z.string(),
  items: z.array(workloadSchema),
  /**
   * Runtimes interrogés et, le cas échéant, pourquoi l'un d'eux n'a rien pu
   * dire. Une liste vide est ambiguë : « rien ne tourne » et « kubectl est
   * injoignable » ne se ressemblent pas.
   */
  runtimes: z.array(
    z.object({
      runtime: workloadRuntimeSchema,
      ok: z.boolean(),
      error: z.string().nullable().default(null),
      count: z.number().int().nonnegative(),
    }),
  ),
});
export type WorkloadList = z.infer<typeof workloadListSchema>;

export const workloadActionSchema = z.enum(['remove', 'update']);
export type WorkloadAction = z.infer<typeof workloadActionSchema>;

/**
 * Progression d'une action sur une charge, publiée sur Redis et relayée en SSE.
 * Même principe que les logs de déploiement : le driver émet des lignes, le
 * worker les publie, la route les relaie. Aucun `tail` sur un fichier.
 */
export const workloadMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('log'),
    payload: z.object({
      ts: z.string(),
      ref: z.string(),
      line: z.string(),
    }),
  }),
  z.object({
    kind: z.literal('lifecycle'),
    payload: z.object({
      ts: z.string(),
      ref: z.string(),
      name: z.string(),
      action: workloadActionSchema,
      status: z.enum(['started', 'succeeded', 'failed']),
      detail: z.string().nullable().default(null),
    }),
  }),
]);
export type WorkloadMessage = z.infer<typeof workloadMessageSchema>;

/** Canal Redis des actions sur les charges d'une cible. */
export function workloadChannel(targetId: string): string {
  return `workload:${targetId}`;
}

/**
 * Message d'un refus, en un seul endroit : la route HTTP le rend en 409, le
 * driver le lève en `DriverError`, et les deux disent donc la même chose.
 */
export function managedWorkloadRefusal(workload: Pick<Workload, 'name' | 'managedApp'>): string {
  const app = workload.managedApp;
  return (
    `« ${workload.name} » est déployée par le panel${app ? ` (application « ${app} »)` : ''} : ` +
    'cet écran ne la supprime pas. Passez par la destruction du déploiement ' +
    "(permission « deployment:destroy »), qui libère aussi son port et met la base à jour."
  );
}
