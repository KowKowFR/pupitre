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
  listApplicationSecrets,
  listApplicationSources,
  listApplicationVersions,
  listImageUpdates,
  listPendingProposals,
  listSourceArchives,
  listSourceConnections,
  listTargets,
  sourceRepositoryUrl,
  type Application,
} from '@pupitre/db';
import { getT } from '@/i18n/server';
import { applications as messages } from '@/i18n/messages/applications';
import { common } from '@/i18n/messages/common';
import { buildSecretViews } from '@/lib/application-secrets';
import { commitSourceOf } from '@/lib/commit';
import { formatSettingsOf } from '@/lib/format';
import type { AuthContext } from '@/lib/rbac';
import { relativeTime } from '@/lib/relative-time';
import { forgeView } from '@/lib/sources';
import { ApplicationArchive, type ArchiveView } from './application-archive';
import { ApplicationBackups } from './application-backups';
import { ApplicationDomains } from './application-domains';
import { ApplicationImages } from './application-images';
import { ApplicationSecrets } from './application-secrets';
import { ApplicationSources, type SourceView } from './application-sources';
import { VersionTimeline, type VersionRow } from './version-timeline';

/** Les onglets de la fiche que seul le serveur sait remplir. */
export type ApplicationRecordTab =
  'versions' | 'code' | 'domains' | 'secrets' | 'backups' | 'images';

export type ApplicationRecord = {
  /** Le slug de l'application : c'est la clé du tiroir. */
  key: string;
  tabs: Partial<Record<ApplicationRecordTab, ReactNode>>;
  counts: Partial<Record<ApplicationRecordTab, number>>;
};

/**
 * La fiche d'une application, rendue au serveur pour son tiroir : l'historique
 * des versions, le code (dépôt lié ou archive), les domaines, les secrets, les
 * sauvegardes et les images. Ce que la ligne de la liste porte déjà — les
 * services, où elle tourne, le déploiement rapide — vit dans l'onglet
 * « Aperçu », côté client, et n'attend pas ce rendu.
 */
export async function applicationRecord(
  application: Application,
  auth: AuthContext,
  settings: AppSettings,
): Promise<ApplicationRecord> {
  const t = await getT(messages);
  const tc = await getT(common);
  const format = formatSettingsOf(settings);

  const [versions, targets, storedSecrets, sources, proposals, connections, imageRows, archives] =
    await Promise.all([
      listApplicationVersions(application.id),
      listTargets(),
      listApplicationSecrets(application.id),
      listApplicationSources(application.id),
      listPendingProposals(application.id),
      listSourceConnections(),
      listImageUpdates(application.id),
      listSourceArchives(application.id),
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

  // Chaque liaison s'ouvre chez sa forge : GitHub, ou la forge Gitea connectée.
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

  // Le code téléversé : seulement sans dépôt lié, et quand il sert — un service
  // qui se construit, ou des archives déjà envoyées.
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
    },
  };
}
