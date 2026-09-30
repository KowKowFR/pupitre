import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAppSettings, getTarget, getTargetPortReport } from '@pupitre/db';
import { z } from 'zod';
import { PageHeader } from '@/components/page-header';
import { TargetLabelChip, sortedLabelEntries } from '@/components/target-label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getT } from '@/i18n/server';
import { targets as messages } from '@/i18n/messages/targets';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { RuntimeBadges, StatusBadge, formatPreflightDate } from '../runtime-badges';
import { PortsPanel } from './ports-panel';
import { PreflightPanel } from './preflight-panel';
import { ReportDetails } from './report-details';
import { WorkloadsPanel } from './workloads-panel';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

export default async function TargetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const auth = await requirePagePermission(`/targets/${parsed.data.id}`, 'target:read');
  const target = await getTarget(parsed.data.id);
  if (!target) notFound();

  const [ports, { settings }, t] = await Promise.all([
    getTargetPortReport(target.id),
    getAppSettings(),
    getT(messages),
  ]);
  const format = formatSettingsOf(settings);
  const labels = sortedLabelEntries(target.labels);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={target.name}
        description={
          <span className="font-mono text-xs">
            {target.sshUser}@{target.host}:{target.port}
          </span>
        }
      />

      {/*
        La fiche a la place que la liste n'a pas : description en entier, et
        toutes les étiquettes, juste sous le nom. C'est la première chose à lire
        quand on arrive sur une machine dont on ne se souvient plus.

        Chaque étiquette renvoie vers la liste filtrée sur elle : « qui d'autre
        porte env=prod ? » est la question qui suit immédiatement.
      */}
      {target.description || labels.length > 0 ? (
        <div className="-mt-2 flex flex-col gap-2.5">
          {target.description ? (
            <p className="max-w-3xl text-sm leading-relaxed text-text-2">{target.description}</p>
          ) : null}
          {labels.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1">
              {labels.map(([key, value]) => (
                <Link
                  key={`${key}=${value}`}
                  href={`/targets?label=${encodeURIComponent(`${key}=${value}`)}`}
                  className="rounded-sm focus-visible:outline-2"
                  title={t('label.link.title', { pair: `${key}=${value}` })}
                >
                  <TargetLabelChip labelKey={key} value={value} />
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('detail.runtimes.title')}</CardTitle>
            <CardDescription>
              {t('detail.runtimes.description', {
                date: formatPreflightDate(target.lastPreflightAt, format, t('preflight.never')),
                timezone: format.timezone,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <RuntimeBadges runtimes={target.runtimesAvailable} />
            <StatusBadge status={target.status} label={t(`status.${target.status}`)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('card.connection')}</CardTitle>
            <CardDescription>{t('detail.connection.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <PreflightPanel
              targetId={target.id}
              canRunPreflight={auth.can('target:update')}
              canEdit={auth.can('target:update')}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('detail.config.title')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('field.authMethod')}>
            {target.authMethod === 'key' ? t('value.auth.key') : t('value.auth.password')}
          </Field>
          <Field label={t('field.sudoMethod')}>
            {target.sudoMethod === 'nopasswd' ? t('value.sudo.nopasswd') : t('value.sudo.password')}
          </Field>
          <Field label={t('field.credential')}>
            <span className="text-text-3">{t('value.credential')}</span>
          </Field>
          <Field label={t('field.portRangeShort')}>
            {target.portRangeStart}–{target.portRangeEnd}
          </Field>
        </CardContent>
      </Card>

      {ports ? (
        <PortsPanel report={ports} firewall={target.preflightReport?.firewall ?? null} />
      ) : null}

      {auth.can('workload:read') ? (
        <WorkloadsPanel targetId={target.id} canManage={auth.can('workload:manage')} />
      ) : null}

      <ReportDetails report={target.preflightReport} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="eyebrow text-text-3">{label}</div>
      <div className="font-mono text-xs text-text">{children}</div>
    </div>
  );
}
