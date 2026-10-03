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
 * Les fenêtres de maintenance telles que l'écran et l'API les rendent : des
 * dates en ISO, la phase calculée à l'instant, et seulement les sujets que la
 * session a le droit de lire — une fenêtre qui nomme une sonde ne la montre
 * pas à qui ne voit pas les sondes, elle dit seulement qu'il y en a.
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
  /** Sujets que la session ne peut pas lire. */
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

/** Les alertes qu'une fenêtre a retenues, pour son tiroir. */
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
 * Ce qui est en maintenance maintenant, vu par la session : par cible et par
 * sonde, les fenêtres qui les couvrent. Lu par qui peut lire le sujet — un
 * observateur voit qu'une machine est en maintenance sans avoir besoin du
 * droit de gérer les fenêtres.
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
 * Les sujets d'une fenêtre doivent exister, et la session doit pouvoir les
 * lire : on ne met pas en sourdine ce qu'on ne voit pas.
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

/** Les fenêtres actives qui couvrent ce sujet, vues par la session. */
export async function coverageOf(
  auth: Reader,
  subject: { type: 'target' | 'monitor'; id: string },
): Promise<CoverageBrief[]> {
  const coverage = await visibleCoverage(auth);
  return (subject.type === 'target' ? coverage.targets : coverage.monitors).get(subject.id) ?? [];
}
