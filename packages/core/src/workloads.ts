import { z } from 'zod';
import { translator, type Translated, type UiLanguage } from './i18n.js';
import { serviceStateSchema } from './supervision.js';

/**
 * Charges qui tournent sur une machine cible.
 *
 * « Charge » et pas « conteneur » : une cible peut être en K3s, où ce qui tourne
 * est un pod piloté par un Deployment. Le panel peut écrire « conteneur » dans
 * son interface quand la cible est en Docker — mais c'est l'écran qui choisit ce
 * mot, à partir de la clé `kind` que le driver a posée. Le code, lui, reste
 * neutre, et aucun appelant ne teste jamais le runtime pour savoir quoi faire.
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

/** Les gestes de cycle de vie : un processus qui démarre, s'arrête, redémarre. */
export const WORKLOAD_CONTROL_ACTIONS = ['start', 'stop', 'restart'] as const;
export const workloadControlActionSchema = z.enum(WORKLOAD_CONTROL_ACTIONS);
export type WorkloadControlAction = z.infer<typeof workloadControlActionSchema>;

export const workloadSchema = z.object({
  runtime: workloadRuntimeSchema,
  /** Poignée opaque, produite et relue par le seul driver de ce runtime. */
  id: z.string().min(1),
  name: z.string().min(1),
  /**
   * Genre de charge, dans le vocabulaire de **ce runtime** : `container`,
   * `deployment`, `statefulset`, `daemonset`, `pod`.
   *
   * C'est une **clé**, pas une phrase — au même titre qu'un `runtime` ou qu'un
   * `state`. Le driver produit une donnée stable ; l'écran qui l'affiche lui
   * donne son mot (`workload.kind.*` dans `messages/targets.ts`) et retombe sur
   * la clé nue si un runtime à venir en nomme une qu'il ne connaît pas. Rien
   * entre les deux ne s'en sert pour décider quoi que ce soit.
   *
   * Le champ n'est volontairement pas une énumération : ajouter un runtime doit
   * rester l'affaire d'une classe, et un genre inconnu doit s'afficher tel quel
   * plutôt que faire échouer la lecture de tout l'inventaire.
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
  /**
   * Les gestes de cycle de vie que **ce runtime** accepte pour cette charge,
   * dans son état présent — c'est le driver qui le sait : un DaemonSet ne
   * s'arrête pas, un pod nu ne se redémarre pas, un conteneur arrêté ne
   * s'arrête pas deux fois, une charge du panel ne fait que redémarrer.
   * L'écran n'offre que ceux-là ; la route et le driver le revérifient.
   */
  controls: z.array(workloadControlActionSchema).default([]),
  /** Une commande peut-elle y être exécutée maintenant ? */
  exec: z.boolean().default(false),
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

export const workloadActionSchema = z.enum([
  'remove',
  'update',
  'start',
  'stop',
  'restart',
  'logs',
  'exec',
]);
export type WorkloadAction = z.infer<typeof workloadActionSchema>;

/** Une commande envoyée dans une charge : bornée en taille, en durée, en sortie. */
export const WORKLOAD_EXEC_MAX_COMMAND = 2000;
export const WORKLOAD_EXEC_TIMEOUT_SEC = 120;
export const WORKLOAD_EXEC_MAX_LINES = 2000;
export const WORKLOAD_LOGS_MAX_TAIL = 2000;

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
      /**
       * L'exécution à laquelle la ligne appartient — une commande, une lecture
       * du journal. Deux écrans ouverts sur la même charge ne mélangent pas
       * leurs sorties. Absent sur les anciennes actions (suppression, mise à
       * jour), qui n'en ont qu'une à la fois.
       */
      run: z.string().optional(),
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
      run: z.string().optional(),
      /** Code de sortie d'une commande, une fois terminée. */
      exitCode: z.number().int().nullable().optional(),
      /** La commande a dépassé son délai et a été interrompue. */
      timedOut: z.boolean().optional(),
      /** La sortie a dépassé sa borne : les lignes suivantes n'ont pas été transmises. */
      truncated: z.boolean().optional(),
    }),
  }),
]);
export type WorkloadMessage = z.infer<typeof workloadMessageSchema>;

/** Canal Redis des actions sur les charges d'une cible. */
export function workloadChannel(targetId: string): string {
  return `workload:${targetId}`;
}

/**
 * Les mots du refus, en un seul endroit.
 *
 * La phrase existe en deux versions plutôt qu'en une avec un morceau optionnel :
 * une charge du panel rattachée à une application se nomme par cette
 * application, et coudre « (application « … ») » au milieu d'un gabarit oblige
 * les deux langues à placer la parenthèse au même endroit. Deux clés coûtent
 * une ligne et laissent l'anglais tourner sa phrase comme il l'entend.
 */
const fr = {
  'managed.refusal':
    '« {name} » est déployée par le panel : ' +
    'cet écran ne la supprime pas. Passez par la destruction du déploiement ' +
    "(permission « deployment:destroy »), qui libère aussi son port et met la base à jour.",
  'managed.refusal.app':
    '« {name} » est déployée par le panel (application « {app} ») : ' +
    'cet écran ne la supprime pas. Passez par la destruction du déploiement ' +
    "(permission « deployment:destroy »), qui libère aussi son port et met la base à jour.",
  'managed.control':
    '« {name} » est déployée par le panel : on ne l’arrête ni ne la démarre d’ici, ' +
    'sinon le panel la croirait toujours en marche. Passez par « Arrêter » ou « Démarrer » ' +
    "sur la page Supervision de l'application — le redémarrage, lui, reste possible ici.",
} as const;

const en: Translated<typeof fr> = {
  'managed.refusal':
    '“{name}” is deployed by the panel: this screen will not remove it. Destroy the ' +
    'deployment instead (permission “deployment:destroy”) — that also frees its port and ' +
    'updates the database.',
  'managed.refusal.app':
    '“{name}” is deployed by the panel (application “{app}”): this screen will not remove ' +
    'it. Destroy the deployment instead (permission “deployment:destroy”) — that also frees ' +
    'its port and updates the database.',
  'managed.control':
    '“{name}” is deployed by the panel: it is neither stopped nor started from here, or the ' +
    'panel would still believe it runs. Use “Stop” or “Start” on the application’s ' +
    'Supervision page — restarting it stays possible here.',
};

export const workloadCopy = { fr, en };

/**
 * Message d'un refus, en un seul endroit : la route HTTP le rend en 409, le
 * driver le lève en `DriverError`, et les deux disent donc la même chose.
 *
 * Le français par défaut : un driver lève cette erreur au fond d'un job, sans
 * langue d'instance sous la main, et sa trace se lit dans les logs. Le panel,
 * lui, passe la sienne.
 */
export function managedWorkloadRefusal(
  workload: Pick<Workload, 'name' | 'managedApp'>,
  language: UiLanguage = 'fr',
): string {
  const t = translator(workloadCopy, language);
  const app = workload.managedApp;
  return app
    ? t('managed.refusal.app', { name: workload.name, app })
    : t('managed.refusal', { name: workload.name });
}

/** Le refus d'arrêter ou de démarrer une charge du panel, hors de sa page Supervision. */
export function managedWorkloadControlRefusal(
  workload: Pick<Workload, 'name'>,
  language: UiLanguage = 'fr',
): string {
  return translator(workloadCopy, language)('managed.control', { name: workload.name });
}
