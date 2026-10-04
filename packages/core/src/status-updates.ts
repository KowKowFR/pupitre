import { z } from 'zod';
import { invalid } from './validation.js';

/**
 * A status page's announcements: dated messages a human publishes during an
 * outage or a maintenance window — "we are investigating", "cause identified",
 * "resolved".
 *
 * An announcement is **attached** to what it comments on: a probe incident, or
 * a maintenance window. It has no life of its own — it appears on the pages that
 * show the affected probe, and disappears with its subject. Its text is written
 * for strangers: it is the only place where a status page carries words nobody
 * put in a label.
 *
 * The phase is a word of the conversation with visitors, not a probe state:
 * announcing "resolved" does not close the incident, which only the probe closes
 * when it sees the target healthy.
 */

export const STATUS_UPDATE_SUBJECTS = ['incident', 'maintenance'] as const;
export type StatusUpdateSubjectType = (typeof STATUS_UPDATE_SUBJECTS)[number];

/** An outage's phases, in the order they usually follow each other. */
export const INCIDENT_UPDATE_PHASES = [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
] as const;

/** A maintenance window's phases. */
export const MAINTENANCE_UPDATE_PHASES = ['scheduled', 'in_progress', 'completed'] as const;

export const STATUS_UPDATE_PHASES = [
  ...INCIDENT_UPDATE_PHASES,
  ...MAINTENANCE_UPDATE_PHASES,
] as const;
export type StatusUpdatePhase = (typeof STATUS_UPDATE_PHASES)[number];

export const STATUS_UPDATE_MESSAGE_MAX = 2000;

/**
 * How long a finished maintenance window stays on a public page — if it carries
 * an announcement: without that, "completed" would never be read, the window
 * disappearing from the page the moment it ends.
 */
export const ENDED_MAINTENANCE_SHOWN_HOURS = 24;

/** How long a closed outage stays offered for announcement: time to write "resolved". */
export const RESOLVED_INCIDENT_ANNOUNCE_DAYS = 7;

/** The phases a subject accepts: one does not "schedule" an outage. */
export function statusUpdatePhasesFor(type: StatusUpdateSubjectType): readonly StatusUpdatePhase[] {
  return type === 'incident' ? INCIDENT_UPDATE_PHASES : MAINTENANCE_UPDATE_PHASES;
}

export function isStatusUpdatePhaseFor(type: StatusUpdateSubjectType, phase: string): boolean {
  return (statusUpdatePhasesFor(type) as readonly string[]).includes(phase);
}

export const statusUpdateSubjectSchema = z.object({
  type: z.enum(STATUS_UPDATE_SUBJECTS),
  id: z.string().uuid(),
});
export type StatusUpdateSubject = z.infer<typeof statusUpdateSubjectSchema>;

/** Plain text: line breaks are kept, no HTML is interpreted. */
export const statusUpdateMessageSchema = z.string().trim().min(1).max(STATUS_UPDATE_MESSAGE_MAX);

export const createStatusUpdateSchema = z
  .object({
    subject: statusUpdateSubjectSchema,
    phase: z.enum(STATUS_UPDATE_PHASES),
    message: statusUpdateMessageSchema,
  })
  .refine((input) => isStatusUpdatePhaseFor(input.subject.type, input.phase), {
    ...invalid('statusUpdate.phase'),
    path: ['phase'],
  });
export type CreateStatusUpdateInput = z.infer<typeof createStatusUpdateSchema>;

/** Correcting an announcement: its phase or its text. The subject does not change. */
export const updateStatusUpdateSchema = z
  .object({
    phase: z.enum(STATUS_UPDATE_PHASES).optional(),
    message: statusUpdateMessageSchema.optional(),
  })
  .refine(
    (patch) => patch.phase !== undefined || patch.message !== undefined,
    invalid('nothingToChange'),
  );
export type UpdateStatusUpdateInput = z.infer<typeof updateStatusUpdateSchema>;

/** A subject's key in an address: `incident:<id>`, `maintenance:<id>`. */
export function statusUpdateSubjectKey(subject: StatusUpdateSubject): string {
  return `${subject.type}:${subject.id}`;
}

export function parseStatusUpdateSubjectKey(
  key: string | null | undefined,
): StatusUpdateSubject | null {
  if (!key) return null;
  const separator = key.indexOf(':');
  if (separator < 0) return null;
  const parsed = statusUpdateSubjectSchema.safeParse({
    type: key.slice(0, separator),
    id: key.slice(separator + 1),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The phase the form offers for the next announcement: that of the last one
 * published — one refines more often than one changes step —, or the subject's
 * first.
 */
export function suggestedStatusUpdatePhase(
  type: StatusUpdateSubjectType,
  latest: StatusUpdatePhase | null,
): StatusUpdatePhase {
  if (latest && isStatusUpdatePhaseFor(type, latest)) return latest;
  return statusUpdatePhasesFor(type)[0]!;
}

// ─── What a visitor reads ─────────────────────────────────────────────────────

/** An announcement as it goes out on a public page: no author, no identifier. */
export type PublicStatusUpdate = {
  phase: StatusUpdatePhase;
  message: string;
  at: string;
};

/** The most recent first: it is the last one a visitor looks for. */
export function latestFirst<T extends { at: string }>(updates: readonly T[]): T[] {
  return [...updates].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** What the top of a page says about an ongoing subject: its last announcement. */
export type StatusNotice = {
  kind: StatusUpdateSubjectType;
  services: string[];
  update: PublicStatusUpdate;
};

/**
 * The announcements to put at the top of the page: for each **ongoing** subject
 * (open outage, started maintenance) that carries at least one, the most recent.
 * A subject without a visible service on the page has none: the announcement
 * would comment on something the visitor does not see.
 */
export function statusNotices(
  subjects: ReadonlyArray<{
    kind: StatusUpdateSubjectType;
    services: readonly string[];
    ongoing: boolean;
    updates: readonly PublicStatusUpdate[];
  }>,
): StatusNotice[] {
  const notices: StatusNotice[] = [];
  for (const subject of subjects) {
    if (!subject.ongoing || subject.services.length === 0) continue;
    const [latest] = latestFirst(subject.updates);
    if (!latest) continue;
    notices.push({ kind: subject.kind, services: [...subject.services], update: latest });
  }
  return notices.sort((a, b) => Date.parse(b.update.at) - Date.parse(a.update.at));
}
