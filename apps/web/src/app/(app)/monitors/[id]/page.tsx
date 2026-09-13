import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  MONITOR_CHECK_RETENTION_DAYS,
  formatCadence,
  isMonitorType,
  monitorTypeDefinition,
} from '@pupitre/core';
import {
  getMonitor,
  listCapturesForIncidents,
  listChecks,
  listIncidents,
  liveReference,
  type CaptureMeta,
} from '@pupitre/db';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/page-header';
import { buildMonitorViews, toCheckView, toIncidentView } from '@/lib/monitors';
import { requirePagePermission } from '@/lib/page-auth';
import { LiveReferenceCard, type CaptureView } from './incident-captures';
import { MonitorDetail } from './monitor-detail';

export const dynamic = 'force-dynamic';

/**
 * Les dates deviennent des chaînes ISO en traversant la frontière serveur →
 * client. Les octets, eux, ne traversent pas : `CaptureMeta` ne les porte pas,
 * et l'image est chargée par son URL — voir `api/monitors/[id]/captures/[…]`.
 */
function toCaptureView(capture: CaptureMeta): CaptureView {
  return {
    id: capture.id,
    kind: capture.kind,
    takenAt: capture.takenAt.toISOString(),
    url: capture.url,
    finalUrl: capture.finalUrl,
    httpStatus: capture.httpStatus,
    pageTitle: capture.pageTitle,
    width: capture.width,
    height: capture.height,
    bytes: capture.bytes,
    truncated: capture.truncated,
    hasImage: capture.hasImage,
    purgedAt: capture.purgedAt?.toISOString() ?? null,
  };
}

export default async function MonitorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePagePermission(`/monitors/${id}`, 'monitor:read');

  const row = await getMonitor(id);
  if (!row) notFound();

  const [[view], checks, incidents, reference] = await Promise.all([
    buildMonitorViews([row]),
    // Deux cents points : de quoi couvrir plus de trois heures d'une sonde à la
    // minute sans faire traverser la moitié de la série à chaque affichage.
    listChecks(id, 200),
    listIncidents(id, 50),
    liveReference(id),
  ]);
  if (!view) notFound();

  /**
   * Les captures des incidents affichés, en **une** requête plutôt qu'une par
   * incident — cinquante incidents feraient cinquante allers-retours. Aucun
   * octet ne remonte ici : ces lignes ne portent que les métadonnées, et
   * l'image est chargée par la route qui la sert.
   */
  const captureRows = await listCapturesForIncidents(incidents.map((incident) => incident.id));
  const captures: Record<string, CaptureView[]> = {};
  for (const capture of captureRows) {
    if (capture.incidentId === null) continue;
    (captures[capture.incidentId] ??= []).push(toCaptureView(capture));
  }

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

      <LiveReferenceCard
        monitorId={id}
        capture={reference === null ? null : toCaptureView(reference)}
      />

      <MonitorDetail
        monitorId={id}
        checks={checks.slice().reverse().map(toCheckView)}
        incidents={incidents.map(toIncidentView)}
        captures={captures}
        metrics={definition?.metrics ?? []}
        lastMetrics={view.lastMetrics}
        retentionDays={MONITOR_CHECK_RETENTION_DAYS}
        uptimeMeans={definition?.uptimeMeans ?? 'part du temps où la sonde était saine'}
      />
    </div>
  );
}
