import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  MONITOR_CHECK_RETENTION_DAYS,
  formatCadence,
  isMonitorType,
  monitorTypeDefinition,
} from '@pupitre/core';
import { getMonitor, listChecks, listIncidents } from '@pupitre/db';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/page-header';
import { buildMonitorViews, toCheckView, toIncidentView } from '@/lib/monitors';
import { requirePagePermission } from '@/lib/page-auth';
import { MonitorDetail } from './monitor-detail';

export const dynamic = 'force-dynamic';

export default async function MonitorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePagePermission(`/monitors/${id}`, 'monitor:read');

  const row = await getMonitor(id);
  if (!row) notFound();

  const [[view], checks, incidents] = await Promise.all([
    buildMonitorViews([row]),
    // Deux cents points : de quoi couvrir plus de trois heures d'une sonde à la
    // minute sans faire traverser la moitié de la série à chaque affichage.
    listChecks(id, 200),
    listIncidents(id, 50),
  ]);
  if (!view) notFound();

  const definition = isMonitorType(row.type) ? monitorTypeDefinition(row.type) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <Link href="/monitors" className="underline-offset-4 hover:underline">
            Sondes
          </Link>
        }
        title={view.name}
        description={
          <>
            <span className="font-mono">{view.target}</span> — {view.typeLabel},{' '}
            {formatCadence(view.intervalSeconds)}. Panne confirmée après {view.failureThreshold}{' '}
            échec{view.failureThreshold > 1 ? 's' : ''} consécutif
            {view.failureThreshold > 1 ? 's' : ''}, rétablissement après {view.recoveryThreshold}{' '}
            succès. {view.neverRan ? 'Jamais exécutée.' : ''}
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={view.enabled ? 'ok' : 'secondary'}>
              {view.enabled ? 'active' : 'suspendue'}
            </Badge>
            <Badge variant="outline">24 h : {view.uptime24h.label}</Badge>
            <Badge variant="outline">7 j : {view.uptime7d.label}</Badge>
            <Button asChild size="sm" variant="outline">
              <Link href="/monitors">Retour</Link>
            </Button>
          </div>
        }
      />

      <MonitorDetail
        checks={checks.slice().reverse().map(toCheckView)}
        incidents={incidents.map(toIncidentView)}
        metrics={definition?.metrics ?? []}
        lastMetrics={view.lastMetrics}
        retentionDays={MONITOR_CHECK_RETENTION_DAYS}
        uptimeMeans={definition?.uptimeMeans ?? 'part du temps où la sonde était saine'}
      />
    </div>
  );
}
