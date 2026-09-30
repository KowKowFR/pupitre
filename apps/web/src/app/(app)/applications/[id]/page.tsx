import { notFound } from 'next/navigation';
import { usableRuntimes } from '@pupitre/core';
import {
  getApplication,
  getAppSettings,
  listApplicationSecrets,
  listApplicationVersions,
  listTargets,
} from '@pupitre/db';
import { z } from 'zod';
import { PageHeader } from '@/components/page-header';
import { Crumb } from '@/components/shell/breadcrumb';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getT } from '@/i18n/server';
import { applications as messages } from '@/i18n/messages/applications';
import { buildSecretViews } from '@/lib/application-secrets';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { ServiceChips } from '../applications-view';
import { ingressOf, serviceRows } from '../rows';
import { ServiceList } from '../service-list';
import { ApplicationActions } from './application-actions';
import { ApplicationSecrets } from './application-secrets';
import { VersionTimeline, type VersionRow } from './version-timeline';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * La fiche d'une application : son AppSpec courante, ses secrets, et
 * l'historique de ses versions — chacune rejouable telle qu'elle est partie.
 */
export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const auth = await requirePagePermission(`/applications/${parsed.data.id}`, 'application:read');
  const t = await getT(messages);
  const { settings } = await getAppSettings();

  const application = await getApplication(parsed.data.id);
  if (!application) notFound();

  const [versions, targets, storedSecrets] = await Promise.all([
    listApplicationVersions(application.id),
    listTargets(),
    listApplicationSecrets(application.id),
  ]);

  const rows: VersionRow[] = versions.map((version) => ({
    ...version,
    createdAt: version.createdAt.toISOString(),
    finishedAt: version.finishedAt?.toISOString() ?? null,
  }));

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

  const spec = application.appSpec;
  const services = serviceRows(spec);

  return (
    <>
      <Crumb label={application.slug} />
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

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
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
        />
      </div>

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
