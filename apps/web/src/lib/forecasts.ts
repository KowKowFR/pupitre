import 'server-only';
import {
  describeForecast,
  forecastSeverityLabel,
  forecastSubjectPath,
  type ForecastKind,
  type ForecastSeverity,
  type ForecastSubjectType,
} from '@pupitre/core';
import { listOpenForecasts, type ForecastRow } from '@pupitre/db';
import { currentLanguage } from '@/i18n/server';
import type { AuthContext } from '@/lib/rbac';

/** A current forecast, put into words for the screen. */
export type ForecastView = {
  id: string;
  kind: ForecastKind;
  severity: ForecastSeverity;
  severityLabel: string;
  subjectType: ForecastSubjectType;
  subjectName: string;
  title: string;
  sentence: string;
  /** The subject's drawer. */
  href: string;
  etaAt: string | null;
  openedAt: string;
};

/** Who can read which subject: the same permission as its screen. */
const READ_PERMISSION = {
  target: 'target:read',
  monitor: 'monitor:read',
  route: 'application:read',
  application: 'application:read',
} as const;

/**
 * The current forecasts the session is allowed to read, in the instance's
 * language. A forecast on a probe is not shown to whoever does not see the probes
 * — the same rule as everywhere.
 */
export async function visibleForecasts(
  auth: Pick<AuthContext, 'can'>,
  filter: { subjectType?: ForecastSubjectType; subjectId?: string } = {},
): Promise<ForecastView[]> {
  const [rows, language] = await Promise.all([listOpenForecasts(filter), currentLanguage()]);
  return rows
    .filter((row) => auth.can(READ_PERMISSION[row.subjectType]))
    .map((row: ForecastRow) => {
      const described = describeForecast(
        {
          kind: row.kind,
          subject: { type: row.subjectType, id: row.subjectId, name: row.subjectName },
          detail: row.detail,
        },
        language,
      );
      return {
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        severityLabel: forecastSeverityLabel(row.severity, language),
        subjectType: row.subjectType,
        subjectName: row.subjectName,
        title: described.title,
        sentence: described.sentence,
        href: forecastSubjectPath({ type: row.subjectType, id: row.subjectId }),
        etaAt: row.etaAt?.toISOString() ?? null,
        openedAt: row.openedAt.toISOString(),
      };
    });
}
