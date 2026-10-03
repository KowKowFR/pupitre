import 'server-only';
import type { ReactNode } from 'react';
import type { DeploymentStatus } from '@pupitre/core';
import {
  getDeploymentForRun,
  getDeploymentSummary,
  listSteps,
  scanDigestForDeployments,
} from '@pupitre/db';
import { commitSourceOf } from '@/lib/commit';
import type { FormatSettings } from '@/lib/format';
import type { AuthContext } from '@/lib/rbac';
import { DeploymentDetail, type StepView } from './deployment-view';

export type RunRecord = {
  /** L'identifiant du run : c'est la clé du tiroir. */
  key: string;
  /** De quoi titrer le tiroir, même quand le run n'est pas sur la page affichée. */
  header: {
    applicationSlug: string;
    number: number;
    specVersion: string | null;
    status: DeploymentStatus;
    targetName: string;
    targetHost: string;
    runtime: string;
  };
  body: ReactNode;
};

/**
 * Le suivi d'un run, rendu au serveur pour son tiroir : le résumé et ses
 * gestes (rollback, arrêt, destruction), le pipeline, le flux de logs, les
 * scans et l'AppSpec figée. Le composant prend ensuite le relais en direct
 * (flux SSE) : l'état initial vient d'ici.
 */
export async function runRecord(
  id: string,
  auth: AuthContext,
  format: FormatSettings,
): Promise<RunRecord | null> {
  const canReadScans = auth.can('scan:read');
  const [deployment, steps, run, digest] = await Promise.all([
    getDeploymentSummary(id),
    listSteps(id),
    // L'AppSpec figée du run : ce qui est réellement parti, pas la spec
    // courante de l'application.
    getDeploymentForRun(id),
    canReadScans ? scanDigestForDeployments([id]) : Promise.resolve(null),
  ]);
  if (!deployment) return null;

  // Version restaurée : lue depuis l'AppSpec figée du déploiement précédent,
  // seule source qui dise ce qui tourne vraiment après un rollback.
  const restored =
    deployment.status === 'rolled_back' && deployment.previousDeploymentId
      ? ((await getDeploymentForRun(deployment.previousDeploymentId))?.deployment ?? null)
      : null;

  const spec = run?.deployment.appSpec ?? null;
  const specVersion =
    spec && typeof spec === 'object' && 'version' in spec && typeof spec.version === 'string'
      ? spec.version
      : null;

  const stepViews: StepView[] = steps.map((step) => ({
    key: step.key,
    label: step.label,
    status: step.status,
    order: step.order,
    error: step.error,
    startedAt: step.startedAt?.toISOString() ?? null,
    finishedAt: step.finishedAt?.toISOString() ?? null,
  }));

  return {
    key: deployment.id,
    header: {
      applicationSlug: deployment.applicationSlug,
      number: deployment.number,
      specVersion,
      status: deployment.status,
      targetName: deployment.targetName,
      targetHost: deployment.targetHost,
      runtime: deployment.runtime,
    },
    body: (
      <DeploymentDetail
        key={deployment.id}
        deployment={{
          id: deployment.id,
          status: deployment.status,
          runtime: deployment.runtime,
          version: deployment.version,
          url: deployment.url,
          failedStep: deployment.failedStep,
          error: deployment.error,
          applicationSlug: deployment.applicationSlug,
          targetName: deployment.targetName,
          targetHost: deployment.targetHost,
          triggeredByEmail: deployment.triggeredByEmail,
          source: commitSourceOf(deployment),
          startedAt: deployment.startedAt?.toISOString() ?? null,
          finishedAt: deployment.finishedAt?.toISOString() ?? null,
          canRollback: auth.can('deployment:rollback'),
          canDestroy: auth.can('deployment:destroy'),
          canUnblock: auth.can('deployment:purge'),
          canReadScans,
          hasPrevious: deployment.previousDeploymentId !== null,
          autoRollback: deployment.autoRollback,
          restoredVersion: restored?.appSpec?.version ?? null,
          spec: spec ? JSON.stringify(spec, null, 2) : null,
          scan: digest?.get(deployment.id) ?? null,
        }}
        steps={stepViews}
        format={format}
      />
    ),
  };
}
