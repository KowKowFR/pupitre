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

/** Une prévision en cours, mise en mots pour l'écran. */
export type ForecastView = {
  id: string;
  kind: ForecastKind;
  severity: ForecastSeverity;
  severityLabel: string;
  subjectType: ForecastSubjectType;
  subjectName: string;
  title: string;
  sentence: string;
  /** Le tiroir du sujet. */
  href: string;
  etaAt: string | null;
  openedAt: string;
};

/** Qui peut lire quel sujet : la même permission que son écran. */
const READ_PERMISSION = {
  target: 'target:read',
  monitor: 'monitor:read',
  route: 'application:read',
  application: 'application:read',
} as const;

/**
 * Les prévisions en cours que la session a le droit de lire, dans la langue
 * de l'instance. Une prévision sur une sonde n'est pas montrée à qui ne voit
 * pas les sondes — la même règle que partout.
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
