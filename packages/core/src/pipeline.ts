import { z } from 'zod';
import { DEFAULT_UI_LANGUAGE, type Bundle, type UiLanguage } from './i18n.js';

/**
 * Definition of the deployment pipeline.
 *
 * Shared between the panel — which creates the steps in the database when
 * queuing the job — and the worker, which runs them. A single source of truth:
 * the UI can show the complete list before the worker has started.
 *
 * `rollback` is declared here like the others, and not inserted during the run.
 * It was decided that **every** step is born in the database when the job is
 * queued, precisely so that the UI shows the complete pipeline from the start; a
 * step appearing along the way would break that guarantee, make the "n / total"
 * counter lie and force the SSE client to handle one more case. It is simply
 * `skipped` when all goes well — exactly like `build` without an image to build
 * or `proxy` without a domain name. A rollback that did not happen is
 * information, not a gap.
 *
 * It comes last because it can only trigger after `healthcheck`'s verdict, and
 * it undoes what `deploy` did.
 */

export const DEPLOYMENT_STEPS = [
  { key: 'preflight', label: 'Préflight de la cible' },
  { key: 'allocate_port', label: 'Réservation du port' },
  { key: 'render', label: 'Rendu des artefacts' },
  { key: 'upload', label: 'Dépôt sur la cible' },
  { key: 'build', label: 'Construction des images' },
  { key: 'scan', label: 'Analyse de sécurité' },
  { key: 'backup', label: 'Sauvegarde avant déploiement' },
  { key: 'deploy', label: 'Démarrage des services' },
  { key: 'healthcheck', label: 'Vérification de santé' },
  { key: 'proxy', label: 'Publication derrière le proxy' },
  { key: 'rollback', label: 'Retour à la version précédente' },
] as const;

export type DeploymentStepKey = (typeof DEPLOYMENT_STEPS)[number]['key'];

/**
 * A step's name, in both languages — **rendered when read**.
 *
 * ── Why the `deployment_steps.label` column is no longer enough ─────────────
 * The panel writes this label into the database when queuing the job. It made no
 * difference as long as there was only one language; it makes no sense anymore
 * since there are two. A label written at creation freezes the instance's
 * language **at deployment time**: switching the panel to English would leave
 * "Vérification de santé" on every past deployment, and on them alone. The
 * pipeline would then show two languages at once.
 *
 * The project's rule is the same as for the activity log: a trace only carries
 * **data**, and the name is rendered when shown. Here the data already exists —
 * `deployment_steps.key` is written next to the label, and it is what has always
 * served the logic. The display joins it.
 *
 * The column is still written, as is: it is the last resort for a step whose key
 * has disappeared from the catalog — a deployment kept after a step was removed
 * from the pipeline. It is the only case where it is read back.
 */
const stepLabels = {
  fr: {
    preflight: 'Préflight de la cible',
    allocate_port: 'Réservation du port',
    render: 'Rendu des artefacts',
    upload: 'Dépôt sur la cible',
    build: 'Construction des images',
    scan: 'Analyse de sécurité',
    backup: 'Sauvegarde avant déploiement',
    deploy: 'Démarrage des services',
    healthcheck: 'Vérification de santé',
    proxy: 'Publication derrière le proxy',
    rollback: 'Retour à la version précédente',
  },
  en: {
    preflight: 'Target preflight',
    allocate_port: 'Port reservation',
    render: 'Artifact rendering',
    upload: 'Upload to the target',
    build: 'Image build',
    scan: 'Security scan',
    backup: 'Backup before deployment',
    deploy: 'Service start-up',
    healthcheck: 'Health check',
    proxy: 'Publication behind the proxy',
    rollback: 'Rollback to the previous version',
  },
} satisfies Bundle<Record<DeploymentStepKey, string>>;

export const deploymentStepLabels = stepLabels;

/**
 * A step's displayable name. `fallback` serves the keys the catalog no longer
 * knows: we then return what the database had written, rather than a bare key
 * in front of a user.
 */
export function deploymentStepLabel(
  key: string,
  language: UiLanguage = DEFAULT_UI_LANGUAGE,
  fallback?: string,
): string {
  const known = stepLabels[language] as Record<string, string | undefined>;
  return known[key] ?? fallback ?? key;
}

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
 * Line published on the `deploy:{deploymentId}` Redis channel.
 * The same shape as the one read back from `deployment_steps.log`: the SSE
 * client makes no difference between history and live.
 */
export const deployLogLineSchema = z.object({
  ts: z.string(),
  step: z.string().min(1),
  stream: z.enum(['stdout', 'stderr']),
  line: z.string(),
});

export type DeployLogLine = z.infer<typeof deployLogLineSchema>;

/** A step's or the deployment's state change, published on the same channel. */
export const deployEventSchema = z.object({
  ts: z.string(),
  type: z.enum(['step', 'deployment']),
  key: z.string().min(1),
  status: z.string().min(1),
  detail: z.string().nullable().default(null),
});

export type DeployEvent = z.infer<typeof deployEventSchema>;

/** Envelope carried on the Redis channel. */
export const deployMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('log'), payload: deployLogLineSchema }),
  z.object({ kind: z.literal('event'), payload: deployEventSchema }),
]);

export type DeployMessage = z.infer<typeof deployMessageSchema>;

export function deployChannel(deploymentId: string): string {
  return `deploy:${deploymentId}`;
}

/** Statuses that mark a deployment's end. */
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
 * ANSI escape sequences, removed before display.
 *
 * `docker compose` produces them even with `--no-color`: cursor moves and line
 * erasures during downloads. We clean up on the server side, once, rather than
 * in each client.
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
