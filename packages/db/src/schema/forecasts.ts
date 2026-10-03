import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { ForecastKind, ForecastSeverity, ForecastSubjectType } from '@pupitre/core';

/**
 * Les prévisions en cours : ce qui va casser, constaté par le balayage du
 * worker (`forecast:sweep`).
 *
 * Une ligne par épisode, comme les dépassements de seuil : ouverte quand le
 * constat apparaît, tenue à jour tant qu'il dure, refermée (`resolved_at`)
 * quand il disparaît. C'est ce qui permet de prévenir **une fois** — à
 * l'ouverture — et non à chaque balayage.
 *
 * Le sujet est polymorphe (une cible, une sonde, une route, une application)
 * et sans clé étrangère : un sujet supprimé ne produit plus de constat, et le
 * balayage suivant referme son épisode.
 */
export const forecasts = pgTable(
  'forecasts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<ForecastKind>().notNull(),
    subjectType: text('subject_type').$type<ForecastSubjectType>().notNull(),
    subjectId: text('subject_id').notNull(),
    /** Le nom du sujet au dernier balayage : la ligne se lit sans jointure. */
    subjectName: text('subject_name').notNull(),
    severity: text('severity').$type<ForecastSeverity>().notNull(),
    /** Quand le mur est atteint, pour les prévisions qui en ont un. */
    etaAt: timestamp('eta_at', { withTimezone: true }),
    /** Les chiffres du constat (rythme, médianes, jours restants…). */
    detail: jsonb('detail').$type<Record<string, number | string | null>>().notNull().default({}),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('forecasts_open_idx')
      .on(t.kind, t.subjectType, t.subjectId)
      .where(sql`${t.resolvedAt} is null`),
    index('forecasts_subject_idx').on(t.subjectType, t.subjectId),
  ],
);

export type ForecastRow = typeof forecasts.$inferSelect;
