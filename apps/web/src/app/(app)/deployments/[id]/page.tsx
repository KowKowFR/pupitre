import { notFound } from 'next/navigation';
import { getDeploymentForRun, getDeploymentSummary, listSteps } from '@pupitre/db';
import { z } from 'zod';
import { PageHeader } from '@/components/page-header';
import { getT } from '@/i18n/server';
import { deployments as messages } from '@/i18n/messages/deployments';
import { requirePagePermission } from '@/lib/page-auth';
import { DeploymentDetail, type StepView } from './deployment-view';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

export default async function DeploymentPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const auth = await requirePagePermission(`/deployments/${parsed.data.id}`, 'deployment:read');
  const t = await getT(messages);

  const [deployment, steps] = await Promise.all([
    getDeploymentSummary(parsed.data.id),
    listSteps(parsed.data.id),
  ]);
  if (!deployment) notFound();

  // Version restaurée : lue depuis l'AppSpec figée du déploiement précédent,
  // seule source qui dise ce qui tourne vraiment après un rollback.
  const restored =
    deployment.status === 'rolled_back' && deployment.previousDeploymentId
      ? ((await getDeploymentForRun(deployment.previousDeploymentId))?.deployment ?? null)
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
    <div className="flex flex-col gap-6">
      <PageHeader
        title={
          <>
            {deployment.applicationSlug}{' '}
            <span className="font-mono text-[1.375rem] font-normal text-text-3">
              v{deployment.version}
            </span>
          </>
        }
        description={t('detail.description', {
          target: deployment.targetName,
          host: deployment.targetHost,
          runtime: deployment.runtime,
          proxy: deployment.proxy,
        })}
      />

      <DeploymentDetail
        deployment={{
          id: deployment.id,
          status: deployment.status,
          runtime: deployment.runtime,
          proxy: deployment.proxy,
          version: deployment.version,
          url: deployment.url,
          failedStep: deployment.failedStep,
          error: deployment.error,
          applicationSlug: deployment.applicationSlug,
          targetName: deployment.targetName,
          targetHost: deployment.targetHost,
          startedAt: deployment.startedAt?.toISOString() ?? null,
          finishedAt: deployment.finishedAt?.toISOString() ?? null,
          canRollback: auth.can('deployment:rollback'),
          canDestroy: auth.can('deployment:destroy'),
          canUnblock: auth.can('deployment:purge'),
          hasPrevious: deployment.previousDeploymentId !== null,
          autoRollback: deployment.autoRollback,
          restoredVersion: restored?.appSpec?.version ?? null,
        }}
        steps={stepViews}
      />
    </div>
  );
}
