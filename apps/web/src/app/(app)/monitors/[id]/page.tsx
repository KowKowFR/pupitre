import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  MONITOR_CHECK_RETENTION_DAYS,
  formatCadence,
  isMonitorType,
  monitorTypeDefinition,
} from '@pupitre/core';
import {
  getAppSettingsValue,
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
import { currentLanguage, getT } from '@/i18n/server';
import { monitors as messages } from '@/i18n/messages/monitors';
import { formatSettingsOf } from '@/lib/format';
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
  const t = await getT(messages);
  const language = await currentLanguage();

  const row = await getMonitor(id);
  if (!row) notFound();

  const [[view], checks, incidents, reference, settings] = await Promise.all([
    buildMonitorViews([row]),
    // Deux cents points : de quoi couvrir plus de trois heures d'une sonde à la
    // minute sans faire traverser la moitié de la série à chaque affichage.
    listChecks(id, 200),
    listIncidents(id, 50),
    liveReference(id),
    getAppSettingsValue(),
  ]);
  if (!view) notFound();

  // Locale et fuseau de l'instance, descendus par props jusqu'aux figures : un
  // graphique et une frise n'ont aucune raison d'inventer leur propre locale.
  const format = formatSettingsOf(settings);

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

  const definition = isMonitorType(row.type) ? monitorTypeDefinition(row.type, language) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={view.name}
        description={
          <>
            <span className="font-mono">{view.target}</span>{' '}
            {t('detail.summary', {
              typeLabel: view.typeLabel,
              cadence: formatCadence(view.intervalSeconds, language),
              failures: t('detail.failures', { count: view.failureThreshold }),
              recovery: view.recoveryThreshold,
            })}{' '}
            {view.neverRan ? t('detail.neverRan') : ''}
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={view.enabled ? 'ok' : 'secondary'}>
              {view.enabled ? t('detail.badge.active') : t('detail.badge.paused')}
            </Badge>
            <Badge variant="outline">
              {t('detail.badge.day', { label: view.uptime24h.label })}
            </Badge>
            <Badge variant="outline">
              {t('detail.badge.week', { label: view.uptime7d.label })}
            </Badge>
            <Button asChild size="sm" variant="outline">
              <Link href="/monitors">{t('detail.back')}</Link>
            </Button>
          </div>
        }
      />

      <LiveReferenceCard
        monitorId={id}
        capture={reference === null ? null : toCaptureView(reference)}
        format={format}
      />

      <MonitorDetail
        monitorId={id}
        checks={checks.slice().reverse().map(toCheckView)}
        incidents={incidents.map(toIncidentView)}
        captures={captures}
        metrics={definition?.metrics ?? []}
        lastMetrics={view.lastMetrics}
        retentionDays={MONITOR_CHECK_RETENTION_DAYS}
        uptimeMeans={definition?.uptimeMeans ?? t('detail.uptimeMeans.fallback')}
        format={format}
      />
    </div>
  );
}
