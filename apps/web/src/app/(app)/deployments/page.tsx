import {
  deploymentQuerySchema,
  getAppSettings,
  listDeployments,
  listLiveDeploymentIds,
  scanDigestForDeployments,
} from '@pupitre/db';
import { Rocket } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { DeployButton } from '@/components/shell/deploy-button';
import { getT } from '@/i18n/server';
import { deployments as messages } from '@/i18n/messages/deployments';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { DeploymentsTable, type StatusFilter } from './deployments-table';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function DeploymentsPage({ searchParams }: { searchParams: SearchParams }) {
  const auth = await requirePagePermission('/deployments', 'deployment:read');
  const t = await getT(messages);

  const raw = await searchParams;
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const single = Array.isArray(value) ? value[0] : value;
    if (single !== undefined && single !== '') flat[key] = single;
  }

  const parsed = deploymentQuerySchema.safeParse(flat);
  const query = parsed.success ? parsed.data : deploymentQuerySchema.parse({});
  const page = await listDeployments(query);
  // Les filtres proposés sont ceux que la requête de liste sait appliquer ;
  // un autre statut passé à la main filtre quand même, sans puce allumée.
  const filter: StatusFilter =
    query.status === 'running' || query.status === 'failed' || query.status === 'rolled_back'
      ? query.status
      : null;

  // Une seule requête pour toute la page : la colonne « Scans » ne doit pas
  // coûter un aller-retour par ligne.
  const digest = await scanDigestForDeployments(page.items.map((item) => item.id));

  // Même critère que l'écran de supervision : le dernier déploiement vivant de
  // chaque couple application+cible. Ce sont eux qui ne se purgent pas — la
  // case désactivée dit pourquoi avant que le serveur n'ait à le refuser.
  const live = await listLiveDeploymentIds();
  const { settings } = await getAppSettings();

  const header = (
    <PageHeader
      title={t('page.title')}
      description={t('page.description')}
      actions={
        auth.can('deployment:create') ? <DeployButton label={t('page.deploy')} /> : undefined
      }
    />
  );

  if (page.total === 0 && !query.status) {
    return (
      <>
        {header}
        <EmptyState icon={Rocket} title={t('empty.title')} hint={t('empty.hint')} />
      </>
    );
  }

  return (
    <>
      {header}
      <DeploymentsTable
        items={page.items.map((item) => ({
          id: item.id,
          status: item.status,
          runtime: item.runtime,
          version: item.version,
          url: item.url,
          applicationSlug: item.applicationSlug,
          targetName: item.targetName,
          triggeredByEmail: item.triggeredByEmail,
          startedAt: item.startedAt?.toISOString() ?? null,
          finishedAt: item.finishedAt?.toISOString() ?? null,
          createdAt: item.createdAt.toISOString(),
          purgeBlocked: live.has(item.id) || item.status === 'pending' || item.status === 'running',
          scan: digest.get(item.id) ?? null,
        }))}
        page={{
          page: page.page,
          totalPages: page.totalPages,
          pageSize: page.pageSize,
          total: page.total,
        }}
        filter={filter}
        canPurge={auth.can('deployment:purge')}
        canRollback={auth.can('deployment:rollback')}
        format={formatSettingsOf(settings)}
      />
    </>
  );
}
