import 'server-only';
import type { ReactNode } from 'react';
import { MONITOR_CHECK_RETENTION_DAYS, isMonitorType, monitorTypeDefinition } from '@pupitre/core';
import {
  countStatusUpdatesByIncident,
  listCapturesForIncidents,
  listChecks,
  listIncidents,
  liveReference,
  type CaptureMeta,
  type Monitor,
} from '@pupitre/db';
import { ForecastPanel } from '@/components/forecasts/forecast-panel';
import {
  MaintenanceMark,
  ScheduleMaintenanceLink,
} from '@/components/maintenance/maintenance-mark';
import { currentLanguage } from '@/i18n/server';
import { visibleForecasts } from '@/lib/forecasts';
import { coverageOf } from '@/lib/maintenance';
import type { FormatSettings } from '@/lib/format';
import { buildMonitorViews, monitorTypeOptions, toCheckView, toIncidentView } from '@/lib/monitors';
import type { AuthContext } from '@/lib/rbac';
import type { EditableMonitor, TypeOption } from '../monitor-form';
import { LiveReferenceCard, type CaptureView } from './incident-captures';
import { MonitorDetail } from './monitor-detail';

export type MonitorRecordTab = 'measures' | 'reference';

export type MonitorRecord = {
  /** The probe's identifier: it is the drawer's key. */
  key: string;
  tabs: Partial<Record<MonitorRecordTab, ReactNode>>;
  /** What opens the overview: the forecasts on the probe (slowdown, instability). */
  alerts: ReactNode;
  /** What the drawer's footer adds: putting under maintenance. */
  actions: ReactNode;
  /** What "Edit" prefills — `null` without `monitor:manage`. */
  edit: { monitor: EditableMonitor; types: TypeOption[] } | null;
};

/**
 * The dates become ISO strings when crossing the server → client boundary. The
 * bytes, for their part, do not cross: `CaptureMeta` does not carry them, and the
 * image is loaded by its URL — see `api/monitors/[id]/captures/[…]`.
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
 * A probe's record, rendered on the server for its drawer: the curve, the
 * incidents and their captures, the measurements table, the reference capture —
 * and what it takes to edit it in place.
 */
export async function monitorRecord(
  row: Monitor,
  auth: AuthContext,
  format: FormatSettings,
): Promise<MonitorRecord | null> {
  const language = await currentLanguage();
  const [[view], checks, incidents, reference, forecasts, maintenance] = await Promise.all([
    buildMonitorViews([row]),
    // Two hundred points: enough to cover more than three hours of a per-minute
    // probe without sending half the series across at each display.
    listChecks(row.id, 200),
    listIncidents(row.id, 50),
    liveReference(row.id),
    visibleForecasts(auth, { subjectType: 'monitor', subjectId: row.id }),
    coverageOf(auth, { type: 'monitor', id: row.id }),
  ]);
  if (!view) return null;

  /**
   * The captures of the displayed incidents, in **one** query rather than one per
   * incident — fifty incidents would make fifty round trips. No byte comes up here:
   * these rows only carry the metadata, and the image is loaded by the route that
   * serves it.
   */
  const captureRows = await listCapturesForIncidents(incidents.map((incident) => incident.id));
  const captures: Record<string, CaptureView[]> = {};
  for (const capture of captureRows) {
    if (capture.incidentId === null) continue;
    (captures[capture.incidentId] ??= []).push(toCaptureView(capture));
  }

  // Announcing an outage to visitors is done from the status pages screen; the
  // record leads there, with the count of what is already published.
  const announcements = auth.can('status_page:announce')
    ? Object.fromEntries(
        await countStatusUpdatesByIncident(incidents.map((incident) => incident.id)),
      )
    : null;

  const definition = isMonitorType(row.type) ? monitorTypeDefinition(row.type, language) : null;
  // Editing requires `monitor:manage` and a type still known to the catalog:
  // without a definition, the form would not know which fields to show.
  const editTypes =
    auth.can('monitor:manage') && isMonitorType(row.type)
      ? ((await monitorTypeOptions([row.type])) as TypeOption[])
      : null;

  return {
    key: row.id,
    alerts: (
      <>
        <MaintenanceMark
          windows={maintenance}
          format={format}
          canRead={auth.can('maintenance:read')}
        />
        <ForecastPanel items={forecasts} compact />
      </>
    ),
    actions:
      auth.can('maintenance:manage') && maintenance.length === 0 ? (
        <ScheduleMaintenanceLink subject="monitor" id={row.id} />
      ) : null,
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
          announcements={announcements}
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
