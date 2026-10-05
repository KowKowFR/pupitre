import {
  MONITOR_CAPTURE_RETENTION_DAYS,
  type CaptureImage,
  type CaptureKind,
} from '@pupitre/core';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { monitorCaptures } from './schema/monitors.js';

/**
 * Persistence of incident screenshots.
 *
 * A module separate from `monitors.ts`, and not out of a taste for tidiness: it
 * is here that the rule "bytes only go out when asked for" is held. Every screen
 * read names its columns and **omits `image`**; a single function loads it, the
 * one serving the image's route. A `select *` on this table would carry
 * megabytes per page.
 */

/** What the screens read: everything except the bytes. */
export type CaptureMeta = {
  id: string;
  monitorId: string;
  incidentId: string | null;
  kind: CaptureKind;
  takenAt: Date;
  url: string;
  finalUrl: string | null;
  httpStatus: number | null;
  pageTitle: string | null;
  width: number;
  height: number;
  format: string;
  bytes: number;
  truncated: boolean;
  elapsedMs: number | null;
  /** `false` when retention took the bytes back. The row stays. */
  hasImage: boolean;
  purgedAt: Date | null;
};

const META_COLUMNS = {
  id: monitorCaptures.id,
  monitorId: monitorCaptures.monitorId,
  incidentId: monitorCaptures.incidentId,
  kind: monitorCaptures.kind,
  takenAt: monitorCaptures.takenAt,
  url: monitorCaptures.url,
  finalUrl: monitorCaptures.finalUrl,
  httpStatus: monitorCaptures.httpStatus,
  pageTitle: monitorCaptures.pageTitle,
  width: monitorCaptures.width,
  height: monitorCaptures.height,
  format: monitorCaptures.format,
  bytes: monitorCaptures.bytes,
  truncated: monitorCaptures.truncated,
  elapsedMs: monitorCaptures.elapsedMs,
  hasImage: sql<boolean>`${monitorCaptures.image} is not null`,
  purgedAt: monitorCaptures.purgedAt,
} as const;

// ─── writing ──────────────────────────────────────────────────────────────────

export type SaveCaptureInput = {
  monitorId: string;
  incidentId: string | null;
  kind: CaptureKind;
  url: string;
  image: CaptureImage;
  takenAt?: Date;
};

/**
 * Records a capture.
 *
 * A **reference** overwrites the probe's live reference: it is the partial
 * unique index that imposes it, and `onConflictDoUpdate` that carries it out.
 * Rotation is therefore not a cleanup task one could forget to run — it is the
 * only write the database accepts.
 */
export async function saveCapture(
  input: SaveCaptureInput,
  db: Database = getDb(),
): Promise<CaptureMeta> {
  const values = {
    monitorId: input.monitorId,
    incidentId: input.incidentId,
    kind: input.kind,
    takenAt: input.takenAt ?? new Date(),
    url: input.url,
    finalUrl: input.image.finalUrl,
    httpStatus: input.image.httpStatus,
    pageTitle: input.image.pageTitle,
    width: input.image.width,
    height: input.image.height,
    format: input.image.format,
    bytes: input.image.data.byteLength,
    truncated: input.image.truncated,
    elapsedMs: input.image.elapsedMs,
    image: Buffer.from(input.image.data),
  };

  const query =
    input.kind === 'reference' && input.incidentId === null
      ? db
          .insert(monitorCaptures)
          .values(values)
          .onConflictDoUpdate({
            target: monitorCaptures.monitorId,
            targetWhere: sql`kind = 'reference' and incident_id is null`,
            set: {
              takenAt: values.takenAt,
              url: values.url,
              finalUrl: values.finalUrl,
              httpStatus: values.httpStatus,
              pageTitle: values.pageTitle,
              width: values.width,
              height: values.height,
              format: values.format,
              bytes: values.bytes,
              truncated: values.truncated,
              elapsedMs: values.elapsedMs,
              image: values.image,
              purgedAt: null,
            },
          })
      : db.insert(monitorCaptures).values(values);

  const [row] = await query.returning(META_COLUMNS);
  if (!row) throw new Error('capture insert returned nothing');
  return row as CaptureMeta;
}

/**
 * Pins a probe's live reference to an incident that just opened.
 *
 * It is the gesture that freezes the "before". Without it, the reference would
 * keep rotating and the incident would end up compared with a page taken *after*
 * the outage — a comparison that lies. Pinning takes it out of the unique index
 * at the same time, which leaves room for the next reference.
 *
 * Returns `null` when there was no reference to pin: a probe down from its first
 * measurement never had a "before", and it is a fact to show, not an error.
 */
export async function pinReferenceToIncident(
  monitorId: string,
  incidentId: string,
  db: Database = getDb(),
): Promise<CaptureMeta | null> {
  const [row] = await db
    .update(monitorCaptures)
    .set({ incidentId })
    .where(
      and(
        eq(monitorCaptures.monitorId, monitorId),
        eq(monitorCaptures.kind, 'reference'),
        isNull(monitorCaptures.incidentId),
      ),
    )
    .returning(META_COLUMNS);
  return (row as CaptureMeta | undefined) ?? null;
}

// ─── reading ──────────────────────────────────────────────────────────────────

/** A probe's captures, the most recent first. Without the bytes. */
export async function listCaptures(
  monitorId: string,
  limit = 200,
  db: Database = getDb(),
): Promise<CaptureMeta[]> {
  const rows = await db
    .select(META_COLUMNS)
    .from(monitorCaptures)
    .where(eq(monitorCaptures.monitorId, monitorId))
    .orderBy(desc(monitorCaptures.takenAt))
    .limit(limit);
  return rows as CaptureMeta[];
}

/** The captures of several incidents, for the timeline. Without the bytes. */
export async function listCapturesForIncidents(
  incidentIds: readonly string[],
  db: Database = getDb(),
): Promise<CaptureMeta[]> {
  if (incidentIds.length === 0) return [];
  const rows = await db
    .select(META_COLUMNS)
    .from(monitorCaptures)
    .where(inArray(monitorCaptures.incidentId, [...incidentIds]))
    .orderBy(monitorCaptures.takenAt);
  return rows as CaptureMeta[];
}

/** A probe's live reference — the "before" of the next incident. */
export async function liveReference(
  monitorId: string,
  db: Database = getDb(),
): Promise<CaptureMeta | null> {
  const [row] = await db
    .select(META_COLUMNS)
    .from(monitorCaptures)
    .where(
      and(
        eq(monitorCaptures.monitorId, monitorId),
        eq(monitorCaptures.kind, 'reference'),
        isNull(monitorCaptures.incidentId),
      ),
    )
    .limit(1);
  return (row as CaptureMeta | undefined) ?? null;
}

export type CaptureBytes = {
  id: string;
  monitorId: string;
  format: string;
  takenAt: Date;
  image: Buffer;
};

/**
 * **The only function that loads the bytes.** Reserved to the route that serves
 * the image, and which requires `monitor:read`.
 */
export async function getCaptureBytes(
  captureId: string,
  db: Database = getDb(),
): Promise<CaptureBytes | null> {
  const [row] = await db
    .select({
      id: monitorCaptures.id,
      monitorId: monitorCaptures.monitorId,
      format: monitorCaptures.format,
      takenAt: monitorCaptures.takenAt,
      image: monitorCaptures.image,
    })
    .from(monitorCaptures)
    .where(eq(monitorCaptures.id, captureId))
    .limit(1);
  if (!row || row.image === null) return null;
  return { ...row, image: row.image };
}

// ─── retention ────────────────────────────────────────────────────────────────

/**
 * Takes back the bytes beyond retention, **without deleting the row**.
 *
 * Incidents are never purged — they tell the story — but their images are:
 * beyond three months, a capture no longer diagnoses anything, it documents.
 * What is purged is therefore the byte, not the fact: the screen keeps saying
 * "an image was taken on …, 214 KB, purged on …". A timeline that says what it
 * lost does not lie; a silently truncated one does.
 */
export async function pruneCaptureImages(
  days: number = MONITOR_CAPTURE_RETENTION_DAYS,
  batch = 500,
  db: Database = getDb(),
): Promise<number> {
  const rows = await db
    .update(monitorCaptures)
    .set({ image: null, purgedAt: new Date() })
    .where(
      sql`${monitorCaptures.id} in (
        select id from ${monitorCaptures}
         where image is not null
           and taken_at < now() - make_interval(days => ${days})
         limit ${batch}
      )`,
    )
    .returning({ id: monitorCaptures.id });
  return rows.length;
}

// ─── what remains to capture ──────────────────────────────────────────────────

export type ReferenceCandidate = {
  monitorId: string;
  type: string;
  config: Record<string, unknown>;
  lastReferenceAt: Date | null;
};

/**
 * The **healthy** probes whose reference is missing or has aged.
 *
 * In SQL and not in TypeScript because the question — "who has no row in this
 * table, or a row older than N hours" — is exactly an outer join, and asking it
 * in memory would require loading every probe and all their captures to keep
 * only five.
 *
 * Only the **healthy** probes: photographing the "normal state" of a site that
 * is down would produce a reference showing the outage, and the next comparison
 * would show nothing.
 */
export async function monitorsDueForReference(
  olderThanHours: number,
  limit: number,
  db: Database = getDb(),
): Promise<ReferenceCandidate[]> {
  const rows = await db.execute<{
    monitorId: string;
    type: string;
    config: Record<string, unknown>;
    lastReferenceAt: Date | null;
  }>(sql`
    select m.id            as "monitorId",
           m.type          as "type",
           m.config        as "config",
           c.taken_at      as "lastReferenceAt"
      from monitors m
      left join ${monitorCaptures} c
        on c.monitor_id = m.id
       and c.kind = 'reference'
       and c.incident_id is null
     where m.enabled
       and m.status = 'healthy'
       and (c.taken_at is null
            or c.taken_at < now() - make_interval(hours => ${olderThanHours}))
     order by c.taken_at asc nulls first, m.created_at asc
     limit ${limit}
  `);
  if (Array.isArray(rows)) return rows as ReferenceCandidate[];
  const wrapped = rows as { rows?: unknown };
  return Array.isArray(wrapped.rows) ? (wrapped.rows as ReferenceCandidate[]) : [];
}
