import {
  deploymentQuerySchema,
  getAppSettings,
  listDeployments,
  listLiveDeploymentIds,
  scanDigestForDeployments,
} from '@pupitre/db';
import { Download, Rocket } from 'lucide-react';
import { z } from 'zod';
import { LiveRefresh } from '@/components/realtime/live-refresh';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/page-header';
import { DeployButton } from '@/components/shell/deploy-button';
import { getT } from '@/i18n/server';
import { deployments as messages } from '@/i18n/messages/deployments';
import { commitSourceOf } from '@/lib/commit';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { DeploymentsTable } from './deployments-table';
import { filterParams, type StatusFilter } from './filters';
import { runRecord } from './record/record';

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
  // The offered filters are those the list query knows how to apply; another status
  // passed by hand filters anyway, without a lit chip.
  const filter: StatusFilter =
    query.blocked === 'scan'
      ? 'scan_blocked'
      : query.status === 'running' || query.status === 'failed' || query.status === 'rolled_back'
        ? query.status
        : null;
  const search = query.q ?? '';
  const filtered = Boolean(query.status || query.blocked || search);

  // A single query for the whole page: the "Scans" column must not cost a round
  // trip per row.
  const digest = await scanDigestForDeployments(page.items.map((item) => item.id));

  // The same criterion as the monitoring screen: the last live deployment of each
  // application+target pair. They are the ones that are not purged — the disabled
  // checkbox says why before the server has to refuse it.
  const live = await listLiveDeploymentIds();
  const { settings } = await getAppSettings();

  // The open run (`?run=<id>`): its complete follow-up, in the drawer — whether or
  // not it is on the displayed page (a "Follow" link leads there directly).
  const wanted = flat.run;
  const record =
    wanted && z.string().uuid().safeParse(wanted).success
      ? await runRecord(wanted, auth, formatSettingsOf(settings))
      : null;

  // The export takes the displayed filters: what one downloads is what one sees,
  // across all pages.
  const exportQuery = filterParams(filter, search).toString();

  const header = (
    <PageHeader
      title={t('page.title')}
      description={t('page.description')}
      actions={
        <>
          {page.total > 0 ? (
            <Button asChild variant="secondary">
              <a href={`/api/deployments/export${exportQuery ? `?${exportQuery}` : ''}`} download>
                <Download aria-hidden />
                {t('page.export')}
              </a>
            </Button>
          ) : null}
          {auth.can('deployment:create') ? <DeployButton label={t('page.deploy')} /> : null}
        </>
      }
    />
  );

  if (page.total === 0 && !filtered) {
    return (
      <>
        {header}
        <EmptyState icon={Rocket} title={t('empty.title')} hint={t('empty.hint')} />
      </>
    );
  }

  return (
    <>
      <LiveRefresh topics={['deployments']} />
      {header}
      <DeploymentsTable
        items={page.items.map((item) => ({
          id: item.id,
          number: item.number,
          status: item.status,
          runtime: item.runtime,
          version: item.version,
          url: item.url,
          applicationSlug: item.applicationSlug,
          targetName: item.targetName,
          triggeredByEmail: item.triggeredByEmail,
          source: commitSourceOf(item),
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
        search={search}
        canPurge={auth.can('deployment:purge')}
        format={formatSettingsOf(settings)}
        record={record}
      />
    </>
  );
}
