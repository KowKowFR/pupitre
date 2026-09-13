import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isSupervisable } from '@pupitre/core';
import { getDeploymentSummary, listSupervisedApps } from '@pupitre/db';
import { z } from 'zod';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/page-header';
import { requirePagePermission } from '@/lib/page-auth';
import { AppConsole, type ConsoleApp } from './app-console';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

export default async function AppPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const auth = await requirePagePermission(`/apps/${parsed.data.id}`, 'deployment:read');
  const deployment = await getDeploymentSummary(parsed.data.id);
  if (!deployment) notFound();

  if (!isSupervisable(deployment.status)) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Supervision"
          title={deployment.applicationSlug}
          description="Ce déploiement ne tourne plus."
        />
        <Alert variant="destructive">
          Ce déploiement est « {deployment.status} » : il n&apos;y a pas d&apos;application à
          suivre. Consultez son{' '}
          <Link href={`/deployments/${deployment.id}`} className="underline underline-offset-4">
            historique de déploiement
          </Link>
          .
        </Alert>
      </div>
    );
  }

  // `listSupervisedApps` porte la santé et la liste des services : on y relit
  // cette application plutôt que de recomposer l'information à la main.
  const supervised = (await listSupervisedApps()).find((app) => app.id === deployment.id);

  const view: ConsoleApp = {
    id: deployment.id,
    applicationSlug: deployment.applicationSlug,
    targetName: deployment.targetName,
    targetHost: deployment.targetHost,
    runtime: deployment.runtime,
    version: deployment.version,
    url: deployment.url,
    publishedPort: deployment.publishedPort,
    healthStatus: supervised?.healthStatus ?? 'unknown',
    services: supervised?.services ?? [],
    canRestart: auth.can('deployment:restart'),
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<Link href="/apps" className="underline-offset-4 hover:underline">← Supervision</Link>}
        title={deployment.applicationSlug}
        description={`v${deployment.version} sur ${deployment.targetName} · ${deployment.runtime} — l'état et les logs ci-dessous sont relus en direct sur la machine, ils ne viennent pas de la base du panel.`}
      />
      {/* La version affichée n'est pas forcément la dernière qu'on a voulu poser. */}
      {supervised?.lastFailedUpdate ? (
        <Alert variant="warn">
          La dernière mise à jour de cette application a échoué (déploiement #
          {supervised.lastFailedUpdate.version}
          {supervised.lastFailedUpdate.failedStep
            ? `, étape ${supervised.lastFailedUpdate.failedStep}`
            : ''}
          ). C&apos;est la version ci-dessous qui reste en service.{' '}
          <Link
            href={`/deployments/${supervised.lastFailedUpdate.deploymentId}`}
            className="underline underline-offset-4"
          >
            Voir le déploiement échoué
          </Link>
          .
        </Alert>
      ) : null}
      <AppConsole app={view} />
    </div>
  );
}
