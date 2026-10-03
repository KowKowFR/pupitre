import 'server-only';
import type { ReactNode } from 'react';
import { MONITOR_CHECK_RETENTION_DAYS, isMonitorType, monitorTypeDefinition } from '@pupitre/core';
import {
  listCapturesForIncidents,
  listChecks,
  listIncidents,
  liveReference,
  type CaptureMeta,
  type Monitor,
} from '@pupitre/db';
import { currentLanguage } from '@/i18n/server';
import type { FormatSettings } from '@/lib/format';
import { buildMonitorViews, monitorTypeOptions, toCheckView, toIncidentView } from '@/lib/monitors';
import type { AuthContext } from '@/lib/rbac';
import type { EditableMonitor, TypeOption } from '../monitor-form';
import { LiveReferenceCard, type CaptureView } from './incident-captures';
import { MonitorDetail } from './monitor-detail';

export type MonitorRecordTab = 'measures' | 'reference';

export type MonitorRecord = {
  /** L'identifiant de la sonde : c'est la clé du tiroir. */
  key: string;
  tabs: Partial<Record<MonitorRecordTab, ReactNode>>;
  /** Ce que « Modifier » préremplit — `null` sans `monitor:manage`. */
  edit: { monitor: EditableMonitor; types: TypeOption[] } | null;
};

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

/**
 * La fiche d'une sonde, rendue au serveur pour son tiroir : la courbe, les
 * incidents et leurs captures, la table des mesures, la capture de référence —
 * et ce qu'il faut pour la modifier sur place.
 */
export async function monitorRecord(
  row: Monitor,
  auth: AuthContext,
  format: FormatSettings,
): Promise<MonitorRecord | null> {
  const language = await currentLanguage();
  const [[view], checks, incidents, reference] = await Promise.all([
    buildMonitorViews([row]),
    // Deux cents points : de quoi couvrir plus de trois heures d'une sonde à la
    // minute sans faire traverser la moitié de la série à chaque affichage.
    listChecks(row.id, 200),
    listIncidents(row.id, 50),
    liveReference(row.id),
  ]);
  if (!view) return null;

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

  return {
    key: row.id,
    edit:
      editTypes && isMonitorType(row.type)
        ? {
            monitor: {
              id: row.id,
              name: view.name,
              type: row.type,
              config: row.config,
              intervalSeconds: view.intervalSeconds,
              failureThreshold: view.failureThreshold,
              recoveryThreshold: view.recoveryThreshold,
              hasWebhook: view.hasWebhook,
            },
            types: editTypes,
          }
        : null,
    tabs: {
      measures: (
        <MonitorDetail
          monitorId={row.id}
          checks={checks.slice().reverse().map(toCheckView)}
          incidents={incidents.map(toIncidentView)}
          captures={captures}
          metrics={definition?.metrics ?? []}
          lastMetrics={view.lastMetrics}
          retentionDays={MONITOR_CHECK_RETENTION_DAYS}
          intervalSeconds={view.intervalSeconds}
          format={format}
        />
      ),
      reference: (
        <LiveReferenceCard
          monitorId={row.id}
          capture={reference === null ? null : toCaptureView(reference)}
          format={format}
        />
      ),
    },
  };
}
