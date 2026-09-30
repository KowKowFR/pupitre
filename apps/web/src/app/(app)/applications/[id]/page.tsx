import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getApplication,
  getAppSettings,
  listApplicationSecrets,
  listApplicationVersions,
  listTargets,
} from '@pupitre/db';
import { z } from 'zod';
import { ChevronLeft } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Badge, CodeBadge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getT } from '@/i18n/server';
import { applications as messages } from '@/i18n/messages/applications';
import { buildSecretViews } from '@/lib/application-secrets';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { ApplicationSecrets } from './application-secrets';
import { VersionTimeline, type VersionRow } from './version-timeline';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

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
  // runtime exploitable. C'est la route qui tranche, l'UI évite juste de
  // proposer l'impossible.
  const deployTargets = targets
    .filter((target) => target.runtimesAvailable.docker.available)
    .map((target) => ({ id: target.id, name: target.name }));

  const spec = application.appSpec;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <Link
            href="/applications"
            className="inline-flex items-center gap-1 transition-colors hover:text-text"
          >
            <ChevronLeft className="size-3" />
            {t('page.title')}
          </Link>
        }
        title={
          <>
            {application.slug}{' '}
            <span className="font-mono text-[1.375rem] font-normal text-text-3">
              v{spec.version}
            </span>
          </>
        }
        description={application.description ?? undefined}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('detail.spec.title')}</CardTitle>
          <CardDescription>{t('detail.spec.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          {spec.services.map((service) =>
            service.exposed ? (
              <Badge key={service.name} variant="default" className="font-mono">
                {service.name}
              </Badge>
            ) : (
              <CodeBadge key={service.name}>{service.name}</CodeBadge>
            ),
          )}
          <span className="font-mono text-xs text-text-3">
            {spec.ingress?.host ?? t('detail.spec.byPort')}
          </span>
        </CardContent>
      </Card>

      <ApplicationSecrets
        applicationId={application.id}
        secrets={buildSecretViews(spec, storedSecrets)}
        canEdit={auth.can('application:update')}
      />

      <div className="flex flex-col gap-1 pt-1">
        <h2 className="text-lg leading-none font-semibold tracking-[0.005em] text-text">
          {t('versions.title')}
        </h2>
        <p className="text-[0.8125rem] text-text-2">
          {rows.length === 0
            ? t('versions.empty')
            : t('versions.count', { count: rows.length })}
        </p>
      </div>

      <VersionTimeline
        applicationId={application.id}
        applicationSlug={application.slug}
        versions={rows}
        targets={deployTargets}
        canRedeploy={auth.can('deployment:create')}
        format={formatSettingsOf(settings)}
      />
    </div>
  );
}
