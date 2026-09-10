import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  failOnEnum,
  scanStatusEnum,
  scanVerdictEnum,
  scannerEnum,
  severityEnum,
} from '../enums.js';
import { deployments } from './deployments.js';

/** Une exécution de scanner sur l'image d'un déploiement. */
export const scanRuns = pgTable(
  'scan_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    scanner: scannerEnum('scanner').notNull(),
    status: scanStatusEnum('status').notNull().default('pending'),
    /** Seuil de blocage, stocké en donnée et non codé en dur. */
    failOn: failOnEnum('fail_on').notNull().default('none'),
    verdict: scanVerdictEnum('verdict').notNull().default('unknown'),
    imageRef: text('image_ref'),
    error: text('error'),
    /** Sortie brute du scanner, conservée telle quelle. */
    raw: jsonb('raw'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('scan_runs_deployment_id_idx').on(t.deploymentId),
    index('scan_runs_scanner_idx').on(t.scanner),
  ],
);

/** Vulnérabilité normalisée, indépendante du scanner qui l'a produite. */
export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanRunId: uuid('scan_run_id')
      .notNull()
      .references(() => scanRuns.id, { onDelete: 'cascade' }),
    cveId: text('cve_id').notNull(),
    severity: severityEnum('severity').notNull().default('unknown'),
    package: text('package').notNull(),
    version: text('version'),
    fixedVersion: text('fixed_version'),
    title: text('title'),
    reference: text('reference'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('findings_scan_run_id_idx').on(t.scanRunId),
    index('findings_severity_idx').on(t.severity),
    index('findings_cve_id_idx').on(t.cveId),
  ],
);
