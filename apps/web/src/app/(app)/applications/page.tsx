import Link from 'next/link';
import { listApplications, listTargets } from '@tp/db';
import { Plus } from 'lucide-react';
import { AppSpecHelpDialog } from '@/components/appspec-help';
import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';
import { requirePagePermission } from '@/lib/page-auth';
import { ApplicationsTable, type ApplicationRow } from './applications-table';

export const dynamic = 'force-dynamic';

export default async function ApplicationsPage() {
  const auth = await requirePagePermission('/applications', 'application:read');
  const [applications, targets] = await Promise.all([listApplications(), listTargets()]);

  const items: ApplicationRow[] = applications.map((application) => ({
    id: application.id,
    slug: application.slug,
    description: application.description,
    version: application.appSpec.version,
    services: application.appSpec.services.map((service) => service.name),
    exposedService: application.appSpec.services.find((service) => service.exposed)?.name ?? '—',
    ingressHost: application.appSpec.ingress?.host ?? null,
    createdAt: application.createdAt.toISOString(),
  }));

  // Une cible n'est déployable que si son preflight a montré un runtime.
  const deployTargets = targets
    .filter((target) => target.runtimesAvailable.docker.available)
    .map((target) => ({
      id: target.id,
      name: target.name,
      host: target.host,
      runtimes: ['docker' as const],
    }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Catalogue"
        title="Applications"
        description={
          <>
            Une application est une <code className="font-mono text-xs">AppSpec</code> — une
            description neutre, qui ne connaît ni Docker ni Kubernetes. C&apos;est le driver qui la
            traduit au moment du déploiement.
          </>
        }
        actions={
          auth.can('application:create') ? (
            <Link href="/applications/new" className={buttonVariants({ size: 'sm' })}>
              <Plus />
              Nouvelle application
            </Link>
          ) : null
        }
      />

      {/* Le tableau ci-dessous parle « service exposé » et « ingress » : le
          vocabulaire vient de l'AppSpec, et se lit ici sans quitter la page. */}
      <AppSpecHelpDialog />

      <ApplicationsTable
        items={items}
        targets={deployTargets}
        canDeploy={auth.can('deployment:create')}
        canDelete={auth.can('application:delete')}
        canConfigureScan={auth.can('scan:configure')}
      />
    </div>
  );
}
