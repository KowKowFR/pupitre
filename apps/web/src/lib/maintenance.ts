import 'server-only';
import {
  maintenancePhase,
  type CreateMaintenanceInput,
  type MaintenancePhase,
} from '@pupitre/core';
import {
  heldMaintenanceAlerts,
  listMonitors,
  listTargets,
  maintenanceCoverage,
  type MaintenanceWindowView,
} from '@pupitre/db';
import { maintenance as messages } from '@/i18n/messages/maintenance';
import { ForbiddenError, NotFoundError, msg } from '@/lib/errors';
import type { AuthContext } from '@/lib/rbac';

/**
 * The maintenance windows as the screen and the API return them: ISO dates, the
 * phase computed at the instant, and only the subjects the session is allowed to
 * read — a window naming a probe does not show it to whoever does not see the
 * probes, it only says there are some.
 */
export type MaintenanceWindowJson = {
  id: string;
  title: string;
  note: string | null;
  startsAt: string;
  endsAt: string;
  phase: MaintenancePhase;
  targets: Array<{ id: string; name: string }>;
  monitors: Array<{ id: string; name: string }>;
  /** Subjects the session cannot read. */
  hiddenSubjects: number;
  held: number;
  released: number;
  createdAt: string;
  updatedAt: string;
};

export type HeldAlertJson = {
  id: string;
  event: string;
  label: string;
  opens: boolean;
  heldAt: string;
  releasedAt: string | null;
};

type Reader = Pick<AuthContext, 'can'>;

export function maintenanceJson(
  window: MaintenanceWindowView,
  auth: Reader,
  now: number = Date.now(),
): MaintenanceWindowJson {
  const targets = auth.can('target:read') ? window.targets : [];
  const monitors = auth.can('monitor:read') ? window.monitors : [];
  return {
    id: window.id,
    title: window.title,
    note: window.note,
    startsAt: window.startsAt.toISOString(),
    endsAt: window.endsAt.toISOString(),
    phase: maintenancePhase(window, now),
    targets,
    monitors,
    hiddenSubjects:
      window.targets.length - targets.length + (window.monitors.length - monitors.length),
    held: window.held,
    released: window.released,
    createdAt: window.createdAt.toISOString(),
    updatedAt: window.updatedAt.toISOString(),
  };
}

/** The alerts a window held, for its drawer. */
export async function heldAlertsJson(windowId: string): Promise<HeldAlertJson[]> {
  const rows = await heldMaintenanceAlerts(windowId);
  return rows.map((row) => ({
    id: row.id,
    event: row.event,
    label: row.label,
    opens: row.opens,
    heldAt: row.heldAt.toISOString(),
    releasedAt: row.releasedAt?.toISOString() ?? null,
  }));
}

export type CoverageBrief = { id: string; title: string; endsAt: string };

/**
 * What is under maintenance now, seen by the session: per target and per probe,
 * the windows that cover them. Read by whoever can read the subject — a viewer
 * sees that a machine is under maintenance without needing the right to manage
 * the windows.
 */
export async function visibleCoverage(auth: Reader): Promise<{
  targets: Map<string, CoverageBrief[]>;
  monitors: Map<string, CoverageBrief[]>;
}> {
  const coverage = await maintenanceCoverage();
  const json = (list: Array<{ id: string; title: string; endsAt: Date }>) =>
    list.map((entry) => ({ ...entry, endsAt: entry.endsAt.toISOString() }));
  return {
    targets: auth.can('target:read')
      ? new Map([...coverage.targets].map(([id, list]) => [id, json(list)]))
      : new Map(),
    monitors: auth.can('monitor:read')
      ? new Map([...coverage.monitors].map(([id, list]) => [id, json(list)]))
      : new Map(),
  };
}

/**
 * A window's subjects must exist, and the session must be able to read them: one
 * does not mute what one does not see.
 */
export async function assertSubjects(
  auth: AuthContext,
  input: Pick<CreateMaintenanceInput, 'targetIds' | 'monitorIds'>,
): Promise<{ targets: string[]; monitors: string[] }> {
  if (input.targetIds.length > 0 && !auth.can('target:read')) {
    throw new ForbiddenError('target:read', msg(messages, 'error.targetsForbidden'));
  }
  if (input.monitorIds.length > 0 && !auth.can('monitor:read')) {
    throw new ForbiddenError('monitor:read', msg(messages, 'error.monitorsForbidden'));
  }
  const [targets, monitors] = await Promise.all([
    input.targetIds.length > 0 ? listTargets() : Promise.resolve([]),
    input.monitorIds.length > 0 ? listMonitors() : Promise.resolve([]),
  ]);
  const targetNames = input.targetIds.map((id) => {
    const found = targets.find((target) => target.id === id);
    if (!found) throw new NotFoundError(msg(messages, 'error.targetNotFound', { id }));
    return found.name;
  });
  const monitorNames = input.monitorIds.map((id) => {
    const found = monitors.find((monitor) => monitor.id === id);
    if (!found) throw new NotFoundError(msg(messages, 'error.monitorNotFound', { id }));
    return found.name;
  });
  return { targets: targetNames, monitors: monitorNames };
}

/** The active windows that cover this subject, seen by the session. */
export async function coverageOf(
  auth: Reader,
  subject: { type: 'target' | 'monitor'; id: string },
): Promise<CoverageBrief[]> {
  const coverage = await visibleCoverage(auth);
  return (subject.type === 'target' ? coverage.targets : coverage.monitors).get(subject.id) ?? [];
}
