import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAppSettings, getTarget, getTargetPortReport } from '@pupitre/db';
import { z } from 'zod';
import { ChevronLeft } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { RuntimeBadges, StatusBadge, formatPreflightDate } from '../runtime-badges';
import { PortsPanel } from './ports-panel';
import { PreflightPanel } from './preflight-panel';
import { ReportDetails } from './report-details';
import { WorkloadsPanel } from './workloads-panel';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

export default async function TargetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const auth = await requirePagePermission(`/targets/${parsed.data.id}`, 'target:read');
  const target = await getTarget(parsed.data.id);
  if (!target) notFound();

  const [ports, { settings }] = await Promise.all([
    getTargetPortReport(target.id),
    getAppSettings(),
  ]);
  const format = formatSettingsOf(settings);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <Link
            href="/targets"
            className="inline-flex items-center gap-1 transition-colors hover:text-ink"
          >
            <ChevronLeft className="size-3" />
            Machines cibles
          </Link>
        }
        title={target.name}
        description={
          <span className="font-mono text-xs">
            {target.sshUser}@{target.host}:{target.port}
          </span>
        }
      />

      <div className="grid items-start gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Runtimes disponibles</CardTitle>
            <CardDescription>
              Dernier preflight : {formatPreflightDate(target.lastPreflightAt, format)} ({format.timezone})
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <RuntimeBadges runtimes={target.runtimesAvailable} />
            <StatusBadge status={target.status} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Connexion</CardTitle>
            <CardDescription>Vérifier ce que la machine sait faire.</CardDescription>
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
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Authentification">
            {target.authMethod === 'key' ? 'clé privée' : 'mot de passe'}
          </Field>
          <Field label="Élévation sudo">
            {target.sudoMethod === 'nopasswd' ? 'sans mot de passe' : 'avec mot de passe'}
          </Field>
          <Field label="Credential">
            <span className="text-ink-faint">chiffré en base, non exposé</span>
          </Field>
          <Field label="Plage de ports">
            {target.portRangeStart}–{target.portRangeEnd}
          </Field>
          <Field label="Étiquettes">
            {Object.keys(target.labels).length === 0
              ? 'aucune'
              : Object.entries(target.labels)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(', ')}
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
      <div className="eyebrow text-ink-faint">{label}</div>
      <div className="font-mono text-xs text-ink">{children}</div>
    </div>
  );
}
