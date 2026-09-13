import {
  MONITOR_CAPTURE_RETENTION_DAYS,
  type CaptureImage,
  type CaptureKind,
} from '@pupitre/core';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { monitorCaptures } from './schema/monitors.js';

/**
 * Persistance des captures d'écran d'incident.
 *
 * Un module à part de `monitors.ts`, et pas par goût du rangement : c'est ici
 * qu'est tenue la règle « les octets ne sortent que quand on les a demandés ».
 * Toutes les lectures d'écran nomment leurs colonnes et **omettent `image`** ;
 * une seule fonction la charge, celle qui sert la route de l'image. Un
 * `select *` sur cette table ferait transiter des mégaoctets par page.
 */

/** Ce que les écrans lisent : tout sauf les octets. */
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
  /** `false` quand la rétention a repris les octets. La ligne, elle, reste. */
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

// ─── écriture ─────────────────────────────────────────────────────────────────

export type SaveCaptureInput = {
  monitorId: string;
  incidentId: string | null;
  kind: CaptureKind;
  url: string;
  image: CaptureImage;
  takenAt?: Date;
};

/**
 * Enregistre une capture.
 *
 * Une **référence** écrase la référence vivante de la sonde : c'est l'index
 * unique partiel qui l'impose, et `onConflictDoUpdate` qui l'exécute. La
 * rotation n'est donc pas une tâche de ménage qu'on pourrait oublier de lancer
 * — c'est la seule écriture que la base accepte.
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
  if (!row) throw new Error('insertion de la capture sans retour');
  return row as CaptureMeta;
}

/**
 * Épingle la référence vivante d'une sonde à un incident qui vient de s'ouvrir.
 *
 * C'est le geste qui fige le « avant ». Sans lui, la référence continuerait de
 * tourner et l'incident se retrouverait comparé à une page prise *après* la
 * panne — une comparaison qui ment. L'épinglage la sort en même temps de
 * l'index unique, ce qui laisse la place à la référence suivante.
 *
 * Rend `null` quand il n'y avait pas de référence à épingler : une sonde en
 * panne dès sa première mesure n'a jamais eu de « avant », et c'est un fait à
 * afficher, pas une erreur.
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

// ─── lecture ──────────────────────────────────────────────────────────────────

/** Les captures d'une sonde, les plus récentes d'abord. Sans les octets. */
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

/** Les captures de plusieurs incidents, pour la chronologie. Sans les octets. */
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

/** La référence vivante d'une sonde — le « avant » du prochain incident. */
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
 * **La seule fonction qui charge les octets.** Réservée à la route qui sert
 * l'image, et qui exige `monitor:read`.
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

// ─── rétention ────────────────────────────────────────────────────────────────

/**
 * Reprend les octets au-delà de la rétention, **sans supprimer la ligne**.
 *
 * Les incidents ne sont jamais purgés — ce sont eux qui racontent l'histoire —
 * mais leurs images, si : au-delà de trois mois, une capture ne diagnostique
 * plus rien, elle documente. Ce qu'on purge est donc l'octet, pas le fait :
 * l'écran continue de dire « une image a été prise le …, 214 Ko, purgée le … ».
 * Une chronologie qui dit ce qu'elle a perdu ne ment pas ; une chronologie
 * amputée en silence, si.
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

// ─── ce qui reste à capturer ──────────────────────────────────────────────────

export type ReferenceCandidate = {
  monitorId: string;
  type: string;
  config: Record<string, unknown>;
  lastReferenceAt: Date | null;
};

/**
 * Les sondes **saines** dont la référence manque ou a vieilli.
 *
 * En SQL et non en TypeScript parce que la question — « qui n'a pas de ligne
 * dans cette table, ou une ligne plus vieille que N heures » — est exactement
 * une jointure externe, et que la poser en mémoire obligerait à charger toutes
 * les sondes et toutes leurs captures pour n'en garder que cinq.
 *
 * Seulement les sondes **saines** : photographier « l'état normal » d'un site
 * qui est en panne produirait une référence qui montre la panne, et la
 * comparaison suivante ne montrerait rien.
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
