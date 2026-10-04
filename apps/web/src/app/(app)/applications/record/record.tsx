import 'server-only';
import type { ReactNode } from 'react';
import {
  branchWebUrl,
  checkDockerfiles,
  checkableImages,
  defaultWatchPaths,
  expectedDockerfiles,
  usableRuntimes,
  type AppSettings,
} from '@pupitre/core';
import {
  applicationScanPolicyOf,
  listApplicationSecrets,
  listApplicationSources,
  listApplicationVersions,
  listImageUpdates,
  listPendingProposals,
  listSourceArchives,
  listSourceConnections,
  listTargets,
  listVulnerabilityAcceptances,
  sourceRepositoryUrl,
  type Application,
} from '@pupitre/db';
import { getT } from '@/i18n/server';
import { applications as messages } from '@/i18n/messages/applications';
import { common } from '@/i18n/messages/common';
import { ForecastPanel } from '@/components/forecasts/forecast-panel';
import { buildSecretViews } from '@/lib/application-secrets';
import { commitSourceOf } from '@/lib/commit';
import { visibleForecasts } from '@/lib/forecasts';
import { formatSettingsOf } from '@/lib/format';
import type { AuthContext } from '@/lib/rbac';
import { relativeTime } from '@/lib/relative-time';
import { forgeView } from '@/lib/sources';
import { acceptanceJson } from '@/lib/vulnerabilities';
import { ApplicationArchive, type ArchiveView } from './application-archive';
import { ApplicationBackups } from './application-backups';
import { ApplicationDomains } from './application-domains';
import { ApplicationImages } from './application-images';
import { ApplicationSecrets } from './application-secrets';
import { ApplicationSecurity } from './application-security';
import { ApplicationSources, type SourceView } from './application-sources';
import { VersionTimeline, type VersionRow } from './version-timeline';

/** The record's tabs that only the server knows how to fill. */
export type ApplicationRecordTab =
  'versions' | 'code' | 'domains' | 'secrets' | 'backups' | 'images' | 'security';

export type ApplicationRecord = {
  /** The application's slug: it is the drawer's key. */
  key: string;
  tabs: Partial<Record<ApplicationRecordTab, ReactNode>>;
  counts: Partial<Record<ApplicationRecordTab, number>>;
  /** What opens the overview: the forecasts on the application (a late backup…). */
  alerts: ReactNode;
};

/**
 * An application's record, rendered on the server for its drawer: the versions'
 * history, the code (linked repository or archive), the domains, the secrets, the
 * backups and the images. What the list's row already carries — the services,
 * where it runs, the quick deployment — lives in the "Overview" tab, on the
 * client side, and does not wait for this rendering.
 */
export async function applicationRecord(
  application: Application,
  auth: AuthContext,
  settings: AppSettings,
): Promise<ApplicationRecord> {
  const t = await getT(messages);
  const tc = await getT(common);
  const format = formatSettingsOf(settings);

  const [
    versions,
    targets,
    storedSecrets,
    sources,
    proposals,
    connections,
    imageRows,
    archives,
    forecasts,
    acceptances,
  ] = await Promise.all([
    listApplicationVersions(application.id),
    listTargets(),
    listApplicationSecrets(application.id),
    listApplicationSources(application.id),
    listPendingProposals(application.id),
    listSourceConnections(),
    listImageUpdates(application.id),
    listSourceArchives(application.id),
    visibleForecasts(auth, { subjectType: 'application', subjectId: application.id }),
    auth.can('scan:read') ? listVulnerabilityAcceptances(application.id) : Promise.resolve([]),
  ]);
  const lastImageCheck =
    imageRows
      .map((row) => row.checkedAt)
      .sort((a, b) => a.getTime() - b.getTime())
      .at(-1) ?? null;

  const rows: VersionRow[] = versions.map(
    ({
      sourceRepository,
      sourceRef,
      sourceSha,
      sourceUrl,
      sourceArchiveName,
      sourceArchiveSha256,
      ...version
    }) => ({
      ...version,
      source: commitSourceOf({ sourceRepository, sourceRef, sourceSha, sourceUrl }),
      archive:
        sourceArchiveName && sourceArchiveSha256
          ? { name: sourceArchiveName, sha256: sourceArchiveSha256 }
          : null,
      createdAt: version.createdAt.toISOString(),
      finishedAt: version.finishedAt?.toISOString() ?? null,
    }),
  );

  // A target only accepts a redeployment if its preflight showed a usable runtime.
  // The route decides; the interface just avoids offering the impossible.
  const deployTargets = targets
    .filter((target) => usableRuntimes(target.runtimesAvailable).length > 0)
    .map((target) => ({
      id: target.id,
      name: target.name,
      runtimes: usableRuntimes(target.runtimesAvailable),
    }));

  // Each link opens at its forge: GitHub, or the connected GitLab or Gitea forge.
  const connectionOf = new Map(connections.map((connection) => [connection.id, connection]));
  const sourceViews: SourceView[] = sources.flatMap((source) => {
    const connection = connectionOf.get(source.connectionId);
    if (!connection) return [];
    const repositoryUrl = sourceRepositoryUrl(connection, source.repository);
    return [
      {
        id: source.id,
        provider: connection.provider,
        repository: source.repository,
        repositoryUrl,
        branchUrl: branchWebUrl(connection.provider, repositoryUrl, source.branch),
        branch: source.branch,
        specPath: source.specPath,
        watchPaths: source.watchPaths,
        defaultWatchPaths: defaultWatchPaths(source.specPath),
        mode: source.mode,
        deployTo: source.deployTo,
        enabled: source.enabled,
        lastSeenSha: source.lastSeenSha,
        syncedSha: source.syncedSha,
        syncedAgo: source.syncedAt ? relativeTime(source.syncedAt, tc) : null,
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
      },
    ];
  });
  const forges = connections.map(forgeView);

  const spec = application.appSpec;

  // The uploaded code: only without a linked repository, and when it serves — a
  // service that builds, or archives already sent.
  const builds = expectedDockerfiles(spec).length > 0;
  const archiveViews: ArchiveView[] = archives.map((archive) => ({
    id: archive.id,
    name: archive.name,
    status: archive.status,
    uploadedBytes: archive.uploadedBytes,
    sha256: archive.sha256,
    files: archive.report?.files ?? null,
    unpackedBytes: archive.report?.unpackedBytes ?? null,
    strippedRoot: archive.report?.strippedRoot ?? null,
    skippedEntries: archive.report?.skippedEntries ?? 0,
    rejection: archive.rejection
      ? { code: archive.rejection, detail: archive.rejectionDetail }
      : null,
    uploadedByName: archive.uploadedByName,
    ago: relativeTime(archive.createdAt, tc),
  }));
  const currentArchive = archives.find((archive) => archive.status !== 'receiving');
  const archiveChecks =
    currentArchive?.status === 'ready' && currentArchive.report
      ? checkDockerfiles(spec, currentArchive.report.dockerfiles)
      : [];
  const secrets = buildSecretViews(spec, storedSecrets);

  return {
    key: application.slug,
    alerts: <ForecastPanel items={forecasts} compact />,
    counts: { versions: rows.length, secrets: secrets.length },
    tabs: {
      versions: (
        <>
          <p className="t-sm text-text-2">
            {rows.length === 0 ? t('versions.empty') : t('versions.count', { count: rows.length })}
          </p>
          <VersionTimeline
            applicationId={application.id}
            applicationSlug={application.slug}
            versions={rows}
            targets={deployTargets}
            canRedeploy={auth.can('deployment:create')}
            format={format}
          />
        </>
      ),
      code: (
        <>
          {sources.length === 0 && (builds || archives.length > 0) ? (
            <ApplicationArchive
              applicationId={application.id}
              archives={archiveViews}
              checks={archiveChecks}
              builds={builds}
              canEdit={auth.can('application:update')}
            />
          ) : null}
          <ApplicationSources
            applicationId={application.id}
            sources={sourceViews}
            targets={deployTargets}
            forges={forges.map((forge) => ({
              provider: forge.provider,
              installUrl: forge.installUrl,
            }))}
            canEdit={auth.can('application:update')}
            canDeploy={auth.can('deployment:create')}
          />
        </>
      ),
      domains: (
        <ApplicationDomains
          applicationId={application.id}
          canEdit={auth.can('deployment:create')}
          format={format}
        />
      ),
      secrets: (
        <ApplicationSecrets
          applicationId={application.id}
          secrets={secrets}
          canEdit={auth.can('application:update')}
          deployedAt={
            versions
              .filter((version) => version.status === 'success')
              .map((version) => version.createdAt.toISOString())
              .sort()
              .at(-1) ?? null
          }
        />
      ),
      ...(auth.can('backup:read')
        ? {
            backups: (
              <ApplicationBackups
                applicationId={application.id}
                applicationSlug={application.slug}
                canManage={auth.can('backup:manage')}
                canRestore={auth.can('backup:restore')}
                canConfigure={auth.can('settings:manage')}
                format={format}
              />
            ),
          }
        : {}),
      images: (
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
      ),
      ...(auth.can('scan:read')
        ? {
            security: (
              <ApplicationSecurity
                applicationId={application.id}
                applicationSlug={application.slug}
                policy={applicationScanPolicyOf(application)}
                instance={{
                  failOn: settings.security.failOn,
                  onlyFixable: settings.security.onlyFixable,
                }}
                acceptances={acceptances.map((acceptance) => acceptanceJson(acceptance))}
                canConfigure={auth.can('scan:configure')}
                format={format}
              />
            ),
          }
        : {}),
    },
  };
}
