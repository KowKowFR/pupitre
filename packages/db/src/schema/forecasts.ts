import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { ForecastKind, ForecastSeverity, ForecastSubjectType } from '@pupitre/core';
import { applications, targets } from './infra.js';
import { monitors } from './monitors.js';
import { routes } from './proxies.js';

/**
 * Les prévisions en cours : ce qui va casser, constaté par le balayage du
 * worker (`forecast:sweep`).
 *
 * Une ligne par épisode, comme les dépassements de seuil : ouverte quand le
 * constat apparaît, tenue à jour tant qu'il dure, refermée (`resolved_at`)
 * quand il disparaît. C'est ce qui permet de prévenir **une fois** — à
 * l'ouverture — et non à chaque balayage.
 *
 * Le sujet est polymorphe (une cible, une sonde, une route, une application) :
 * `subject_type` + `subject_id`, ce qui se lit. Et pour que **la base**
 * garantisse qu'une prévision ne survit pas à son sujet, une colonne générée
 * par type, chacune clé étrangère `ON DELETE CASCADE` : supprimer une cible
 * emporte ses prévisions dans la même transaction, par n'importe quel chemin —
 * la route d'API, ou la cascade d'une application qui emporte ses domaines.
 * Postgres calcule ces colonnes : aucun code ne les écrit, elles ne peuvent
 * pas contredire le sujet.
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
    targetId: uuid('target_id')
      .generatedAlwaysAs(sql`case when subject_type = 'target' then subject_id::uuid end`)
      .references(() => targets.id, { onDelete: 'cascade' }),
    monitorId: uuid('monitor_id')
      .generatedAlwaysAs(sql`case when subject_type = 'monitor' then subject_id::uuid end`)
      .references(() => monitors.id, { onDelete: 'cascade' }),
    routeId: uuid('route_id')
      .generatedAlwaysAs(sql`case when subject_type = 'route' then subject_id::uuid end`)
      .references(() => routes.id, { onDelete: 'cascade' }),
    applicationId: uuid('application_id')
      .generatedAlwaysAs(sql`case when subject_type = 'application' then subject_id::uuid end`)
      .references(() => applications.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('forecasts_open_idx')
      .on(t.kind, t.subjectType, t.subjectId)
      .where(sql`${t.resolvedAt} is null`),
    index('forecasts_subject_idx').on(t.subjectType, t.subjectId),
  ],
);

export type ForecastRow = typeof forecasts.$inferSelect;
