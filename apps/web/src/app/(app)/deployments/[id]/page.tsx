import { notFound } from 'next/navigation';
import {
  getAppSettings,
  getDeploymentForRun,
  getDeploymentSummary,
  listSteps,
  scanDigestForDeployments,
} from '@pupitre/db';
import { z } from 'zod';
import { PageHeader } from '@/components/page-header';
import { Crumb } from '@/components/shell/breadcrumb';
import { getT } from '@/i18n/server';
import { deployments as messages } from '@/i18n/messages/deployments';
import { commitSourceOf } from '@/lib/commit';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { DeploymentDetail, type StepView } from './deployment-view';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

export default async function DeploymentPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const auth = await requirePagePermission(`/deployments/${parsed.data.id}`, 'deployment:read');
  const t = await getT(messages);
  const canReadScans = auth.can('scan:read');

  const [deployment, steps, run, digest, { settings }] = await Promise.all([
    getDeploymentSummary(parsed.data.id),
    listSteps(parsed.data.id),
    // L'AppSpec figée du run : ce qui est réellement parti, pas la spec
    // courante de l'application.
    getDeploymentForRun(parsed.data.id),
    canReadScans ? scanDigestForDeployments([parsed.data.id]) : Promise.resolve(null),
    getAppSettings(),
  ]);
  if (!deployment) notFound();

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

  return (
    <>
      <Crumb label={`#${deployment.number}`} />
      <PageHeader
        title={
          <>
            {deployment.applicationSlug}{' '}
            <span className="mono text-[18px] font-normal text-text-3">
              {specVersion ? `${specVersion} · ` : ''}#{deployment.number}
            </span>
          </>
        }
        description={t('detail.description', {
          target: deployment.targetName,
          host: deployment.targetHost,
          runtime: deployment.runtime,
        })}
      />

      <DeploymentDetail
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
        format={formatSettingsOf(settings)}
      />
    </>
  );
}
