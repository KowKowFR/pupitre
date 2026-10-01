import { notFound } from 'next/navigation';
import { checkableImages, defaultWatchPaths, usableRuntimes } from '@pupitre/core';
import {
  getApplication,
  getAppSettings,
  getSourceConnection,
  listApplicationSecrets,
  listApplicationSources,
  listApplicationVersions,
  listImageUpdates,
  listPendingProposals,
  listTargets,
} from '@pupitre/db';
import { z } from 'zod';
import { PageHeader } from '@/components/page-header';
import { LiveRefresh } from '@/components/realtime/live-refresh';
import { Crumb } from '@/components/shell/breadcrumb';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getT } from '@/i18n/server';
import { applications as messages } from '@/i18n/messages/applications';
import { common } from '@/i18n/messages/common';
import { buildSecretViews } from '@/lib/application-secrets';
import { commitSourceOf } from '@/lib/commit';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { relativeTime } from '@/lib/relative-time';
import { connectionView } from '@/lib/sources';
import { ServiceChips } from '../applications-view';
import { ingressOf, serviceRows } from '../rows';
import { ServiceList } from '../service-list';
import { ApplicationActions } from './application-actions';
import { ApplicationImages } from './application-images';
import { ApplicationSecrets } from './application-secrets';
import { ApplicationSources, type SourceView } from './application-sources';
import { VersionTimeline, type VersionRow } from './version-timeline';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * La fiche d'une application : son AppSpec courante, ses secrets, le dépôt
 * qu'elle suit, et l'historique de ses versions — chacune rejouable telle
 * qu'elle est partie.
 */
export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const auth = await requirePagePermission(`/applications/${parsed.data.id}`, 'application:read');
  const t = await getT(messages);
  const tc = await getT(common);
  const { settings } = await getAppSettings();

  const application = await getApplication(parsed.data.id);
  if (!application) notFound();

  const [versions, targets, storedSecrets, sources, proposals, connection, imageRows] =
    await Promise.all([
      listApplicationVersions(application.id),
      listTargets(),
      listApplicationSecrets(application.id),
      listApplicationSources(application.id),
      listPendingProposals(application.id),
      getSourceConnection('github'),
      listImageUpdates(application.id),
    ]);
  const lastImageCheck =
    imageRows
      .map((row) => row.checkedAt)
      .sort((a, b) => a.getTime() - b.getTime())
      .at(-1) ?? null;

  const rows: VersionRow[] = versions.map(
    ({ sourceRepository, sourceRef, sourceSha, ...version }) => ({
      ...version,
      source: commitSourceOf({ sourceRepository, sourceRef, sourceSha }),
      createdAt: version.createdAt.toISOString(),
      finishedAt: version.finishedAt?.toISOString() ?? null,
    }),
  );

  // Une cible n'accueille un redéploiement que si son preflight a montré un
  // runtime exploitable. C'est la route qui tranche ; l'interface évite juste
  // de proposer l'impossible.
  const deployTargets = targets
    .filter((target) => usableRuntimes(target.runtimesAvailable).length > 0)
    .map((target) => ({
      id: target.id,
      name: target.name,
      runtimes: usableRuntimes(target.runtimesAvailable),
    }));

  const sourceViews: SourceView[] = sources.map((source) => ({
    id: source.id,
    repository: source.repository,
    branch: source.branch,
    specPath: source.specPath,
    watchPaths: source.watchPaths,
    defaultWatchPaths: defaultWatchPaths(source.specPath),
    mode: source.mode,
    enabled: source.enabled,
    lastSeenSha: source.lastSeenSha,
    checkedAgo: relativeTime(source.lastCheckedAt, tc),
    lastError: source.lastError,
    targets: source.targets,
    proposals: proposals
      .filter((proposal) => proposal.sourceId === source.id)
      .map((proposal) => ({
        id: proposal.id,
        sha: proposal.sha,
        commitMessage: proposal.commitMessage,
        commitAuthor: proposal.commitAuthor,
        commitUrl: proposal.commitUrl,
        reason: proposal.reason,
        changes: proposal.changes,
        receivedAgo: relativeTime(proposal.createdAt, tc),
      })),
  }));
  const linkedTo = connection ? connectionView(connection) : null;

  const spec = application.appSpec;
  const services = serviceRows(spec);

  return (
    <>
      <Crumb label={application.slug} />
      <LiveRefresh topics={['applications']} />
      <PageHeader
        title={application.slug}
        status={<span className="mono text-[15px] text-text-3">{spec.version}</span>}
        description={application.description ?? undefined}
        actions={
          <ApplicationActions
            application={{ id: application.id, slug: application.slug }}
            canDeploy={auth.can('deployment:create')}
            canDelete={auth.can('application:delete')}
          />
        }
      >
        <div className="mt-1">
          <ServiceChips services={services} />
        </div>
      </PageHeader>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{t('detail.spec.title')}</CardTitle>
            <CardDescription>{t('detail.spec.description')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            <ServiceList application={{ services, ingress: ingressOf(spec) }} />
          </CardContent>
        </Card>

        <ApplicationSecrets
          applicationId={application.id}
          secrets={buildSecretViews(spec, storedSecrets)}
          canEdit={auth.can('application:update')}
          deployedAt={
            versions
              .filter((version) => version.status === 'success')
              .map((version) => version.createdAt.toISOString())
              .sort()
              .at(-1) ?? null
          }
        />
      </div>

      <ApplicationImages
        applicationId={application.id}
        applicationSlug={application.slug}
        rows={imageRows.map((row) => ({
          targetId: row.targetId,
          targetName: row.targetName,
          deploymentId: row.deploymentId,
          service: row.service,
          image: row.image,
          status: row.status,
          runningDigest: row.runningDigest,
          latestDigest: row.latestDigest,
          newerTag: row.newerTag,
          nextMajorTag: row.nextMajorTag,
          error: row.error,
        }))}
        checkable={checkableImages(spec).length}
        checkedAt={lastImageCheck?.toISOString() ?? null}
        checkedAgo={relativeTime(lastImageCheck, tc)}
        canDeploy={auth.can('deployment:create')}
      />

      <ApplicationSources
        applicationId={application.id}
        sources={sourceViews}
        targets={deployTargets}
        connection={linkedTo ? { installUrl: linkedTo.installUrl } : null}
        canEdit={auth.can('application:update')}
        canDeploy={auth.can('deployment:create')}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('versions.title')}</CardTitle>
          <CardDescription>
            {rows.length === 0 ? t('versions.empty') : t('versions.count', { count: rows.length })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VersionTimeline
            applicationId={application.id}
            applicationSlug={application.slug}
            versions={rows}
            targets={deployTargets}
            canRedeploy={auth.can('deployment:create')}
            format={formatSettingsOf(settings)}
          />
        </CardContent>
      </Card>
    </>
  );
}
