import { z } from 'zod';

/**
 * Définition du pipeline de déploiement.
 *
 * Partagée entre le panel — qui crée les steps en base au moment d'enfiler le
 * job — et le worker, qui les exécute. Une seule source de vérité : l'UI peut
 * afficher la liste complète avant que le worker n'ait commencé.
 *
 * `rollback` est déclarée ici comme les autres, et non insérée en cours
 * d'exécution. Le jalon 4 a tranché que **toutes** les steps naissent en base
 * au moment d'enfiler le job, précisément pour que l'UI montre le pipeline
 * complet d'emblée ; une step qui apparaîtrait en cours de route romprait cette
 * garantie, ferait mentir le compteur « n / total » et obligerait le client SSE
 * à gérer un cas de plus. Elle est simplement `skipped` quand tout va bien —
 * exactement comme `build` sans image à construire ou `proxy` sans nom de
 * domaine. Un rollback qui n'a pas eu lieu est une information, pas un trou.
 *
 * Elle est en dernier parce qu'elle ne peut se déclencher qu'après le verdict de
 * `healthcheck`, et qu'elle défait ce que `deploy` a fait.
 */

export const DEPLOYMENT_STEPS = [
  { key: 'preflight', label: 'Préflight de la cible' },
  { key: 'allocate_port', label: 'Réservation du port' },
  { key: 'render', label: 'Rendu des artefacts' },
  { key: 'upload', label: 'Dépôt sur la cible' },
  { key: 'build', label: 'Construction des images' },
  { key: 'scan', label: 'Analyse de sécurité' },
  { key: 'deploy', label: 'Démarrage des services' },
  { key: 'healthcheck', label: 'Vérification de santé' },
  { key: 'proxy', label: 'Publication derrière le proxy' },
  { key: 'rollback', label: 'Retour à la version précédente' },
] as const;

export type DeploymentStepKey = (typeof DEPLOYMENT_STEPS)[number]['key'];

export const deploymentStepKeys: readonly DeploymentStepKey[] = DEPLOYMENT_STEPS.map(
  (step) => step.key,
);

export const stepStatusSchema = z.enum(['pending', 'running', 'success', 'failed', 'skipped']);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const deploymentStatusSchema = z.enum([
  'pending',
  'running',
  'success',
  'failed',
  'rolled_back',
  'destroyed',
]);
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

/**
 * Ligne publiée sur le canal Redis `deploy:{deploymentId}`.
 * Même forme que celle relue depuis `deployment_steps.log` : le client SSE ne
 * fait aucune différence entre l'historique et le direct.
 */
export const deployLogLineSchema = z.object({
  ts: z.string(),
  step: z.string().min(1),
  stream: z.enum(['stdout', 'stderr']),
  line: z.string(),
});

export type DeployLogLine = z.infer<typeof deployLogLineSchema>;

/** Changement d'état d'une step ou du déploiement, publié sur le même canal. */
export const deployEventSchema = z.object({
  ts: z.string(),
  type: z.enum(['step', 'deployment']),
  key: z.string().min(1),
  status: z.string().min(1),
  detail: z.string().nullable().default(null),
});

export type DeployEvent = z.infer<typeof deployEventSchema>;

/** Enveloppe transportée sur le canal Redis. */
export const deployMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('log'), payload: deployLogLineSchema }),
  z.object({ kind: z.literal('event'), payload: deployEventSchema }),
]);

export type DeployMessage = z.infer<typeof deployMessageSchema>;

export function deployChannel(deploymentId: string): string {
  return `deploy:${deploymentId}`;
}

/** Statuts qui signent la fin d'un déploiement. */
export const TERMINAL_DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = [
  'success',
  'failed',
  'rolled_back',
  'destroyed',
];

export function isTerminal(status: DeploymentStatus): boolean {
  return TERMINAL_DEPLOYMENT_STATUSES.includes(status);
}

/**
 * Séquences d'échappement ANSI, retirées avant affichage.
 *
 * `docker compose` en produit même avec `--no-color` : déplacements de curseur
 * et effacements de ligne pendant les téléchargements. On nettoie côté serveur,
 * une fois, plutôt que dans chaque client.
 */
const ESC = '\u001B';
const ANSI_PATTERN = new RegExp(
  `[${ESC}][[\\]()#;?]*` +
    `(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]` +
    `|(?:[A-Za-z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?)`,
  'g',
);

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}
