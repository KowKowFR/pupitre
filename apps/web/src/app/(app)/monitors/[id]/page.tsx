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
import { PageHeader } from '@/components/page-header';
import { Crumb } from '@/components/shell/breadcrumb';
import { currentLanguage, getT } from '@/i18n/server';
import { monitors as messages } from '@/i18n/messages/monitors';
import { formatSettingsOf } from '@/lib/format';
import { buildMonitorViews, monitorTypeOptions, toCheckView, toIncidentView } from '@/lib/monitors';
import { requirePagePermission } from '@/lib/page-auth';
import type { TypeOption } from '../monitor-form';
import { LiveReferenceCard, type CaptureView } from './incident-captures';
import { MonitorDetail } from './monitor-detail';
import { MonitorEdit } from './monitor-edit';

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
  const auth = await requirePagePermission(`/monitors/${id}`, 'monitor:read');
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
  // Modifier demande `monitor:manage` et un type encore connu du catalogue :
  // sans définition, le formulaire ne saurait pas quels champs montrer.
  const editTypes =
    auth.can('monitor:manage') && isMonitorType(row.type)
      ? ((await monitorTypeOptions([row.type])) as TypeOption[])
      : null;

  return (
    <>
      <Crumb label={view.name} />
      <PageHeader
        title={view.name}
        description={
          <>
            <span className="mono">{view.target}</span>
            {' · '}
            {t('drawer.summary', {
              typeLabel: view.typeLabel,
              cadence: formatCadence(view.intervalSeconds, language),
              failures: t('detail.failures', { count: view.failureThreshold }),
              recovery: view.recoveryThreshold,
            })}{' '}
            {view.neverRan ? t('detail.neverRan') : ''}
          </>
        }
        actions={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge variant={view.enabled ? 'ok' : 'idle'} dot>
              {view.enabled ? t('detail.badge.active') : t('detail.badge.paused')}
            </Badge>
            <Badge title={view.uptime24h.label}>
              {t('detail.badge.day', { label: view.uptime24h.label })}
            </Badge>
            <Badge title={view.uptime7d.label}>
              {t('detail.badge.week', { label: view.uptime7d.label })}
            </Badge>
            {editTypes && isMonitorType(row.type) ? (
              <MonitorEdit
                monitor={{
                  id,
                  name: view.name,
                  type: row.type,
                  config: row.config,
                  intervalSeconds: view.intervalSeconds,
                  failureThreshold: view.failureThreshold,
                  recoveryThreshold: view.recoveryThreshold,
                  hasWebhook: view.hasWebhook,
                }}
                types={editTypes}
              />
            ) : null}
          </span>
        }
      />

      <MonitorDetail
        monitorId={id}
        checks={checks.slice().reverse().map(toCheckView)}
        incidents={incidents.map(toIncidentView)}
        captures={captures}
        metrics={definition?.metrics ?? []}
        lastMetrics={view.lastMetrics}
        retentionDays={MONITOR_CHECK_RETENTION_DAYS}
        intervalSeconds={view.intervalSeconds}
        format={format}
      />

      <LiveReferenceCard
        monitorId={id}
        capture={reference === null ? null : toCaptureView(reference)}
        format={format}
      />
    </>
  );
}
