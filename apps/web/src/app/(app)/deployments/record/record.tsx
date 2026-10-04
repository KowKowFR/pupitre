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
  /** The run's identifier: it is the drawer's key. */
  key: string;
  /** What it takes to title the drawer, even when the run is not on the displayed page. */
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
 * A run's follow-up, rendered on the server for its drawer: the summary and its
 * gestures (rollback, stop, destruction), the pipeline, the log stream, the scans
 * and the frozen AppSpec. The component then takes over live (SSE stream): the
 * initial state comes from here.
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
    // The run's frozen AppSpec: what really went out, not the application's current
    // spec.
    getDeploymentForRun(id),
    canReadScans ? scanDigestForDeployments([id]) : Promise.resolve(null),
  ]);
  if (!deployment) return null;

  // The restored version: read from the previous deployment's frozen AppSpec, the
  // only source that says what really runs after a rollback.
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
