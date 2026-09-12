import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { getDeploymentForRun, getDeploymentSummary, listSteps } from '@pupitre/db';
import { z } from 'zod';
import { PageHeader } from '@/components/page-header';
import { requirePagePermission } from '@/lib/page-auth';
import { DeploymentDetail, type StepView } from './deployment-view';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

export default async function DeploymentPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const auth = await requirePagePermission(`/deployments/${parsed.data.id}`, 'deployment:read');

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
        eyebrow={
          <Link
            href="/deployments"
            className="inline-flex items-center gap-1 transition-colors hover:text-ink"
          >
            <ChevronLeft className="size-3" />
            Déploiements
          </Link>
        }
        title={
          <>
            {deployment.applicationSlug}{' '}
            <span className="font-mono text-[1.375rem] font-normal text-ink-faint">
              v{deployment.version}
            </span>
          </>
        }
        description={`Déployé sur ${deployment.targetName} (${deployment.targetHost}) en ${deployment.runtime}, derrière ${deployment.proxy}.`}
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
