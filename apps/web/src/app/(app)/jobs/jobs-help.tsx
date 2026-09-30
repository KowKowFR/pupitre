'use client';

import {
  CalendarClock,
  Clock,
  Code as CodeIcon,
  Gauge,
  Globe,
  Lightbulb,
  MousePointerClick,
  SlidersHorizontal,
} from 'lucide-react';
import { SCHEDULED_JOB_TYPES_LIST, scheduledJobTypes } from '@pupitre/core/schedule';
import type { Translate as CoreTranslate } from '@pupitre/core';
import * as React from 'react';
import {
  HelpBlock,
  HelpCallout,
  HelpCode as Code,
  HelpDrawer,
  HelpSection,
  HelpTable,
} from '@/components/help-drawer';
import { useLanguage, useT } from '@/i18n/client';
import { jobs as messages } from '@/i18n/messages/jobs';

/**
 * Aide sur les tâches planifiées — contenu statique, aucune donnée serveur.
 *
 * Un tiroir du kit d'aide (`components/help-drawer.tsx`) ; tout ce qui parle
 * d'ordonnancement vit ici. Chaque phrase suit
 * `apps/worker/src/schedule/runners.ts` et `apps/worker/src/handlers/scheduled.ts`
 * — ce qui est décrit est ce que le code fait, pas ce qu'on aimerait qu'il fasse.
 */

type Props = {
  label?: string;
  className?: string;
  /** Fuseau des paramètres d'instance : le pré-réglage d'une tâche neuve. */
  defaultTimeZone: string;
};

type Translate = CoreTranslate<(typeof messages)['fr']>;

/**
 * Ce que fait *réellement* chaque type, lu dans les runners du worker.
 * Le catalogue de `@pupitre/core/schedule` fournit le nom BullMQ, le libellé et
 * la garantie négative ; cette table ajoute le déroulé et le paramétrage.
 *
 * Une fonction et non une constante : les phrases traversent des `<Code>`, donc
 * elles se composent de fragments traduits, et un fragment se lit au rendu.
 */
function whatTheyDo(
  t: Translate,
): Record<
  (typeof SCHEDULED_JOB_TYPES_LIST)[number],
  { steps: React.ReactNode; payload: React.ReactNode }
> {
  return {
    scan: {
      steps: (
        <>
          {t('help.scan.steps.a')}
          <em>{t('help.scan.steps.current')}</em>
          {t('help.scan.steps.b')}
          <strong>{t('help.scan.steps.stack')}</strong>
          {t('help.scan.steps.c')}
        </>
      ),
      payload: (
        <>
          <Code>scanners</Code>
          {t('help.scan.payload.a')}
          <Code>failOn</Code>
          {t('help.scan.payload.b')}
          <Code>applicationIds</Code>
          {t('help.scan.payload.c')}
          <Code>targetIds</Code>
          {t('help.scan.payload.d')}
        </>
      ),
    },
    healthcheck: {
      steps: (
        <>
          {t('help.healthcheck.steps.a')}
          <Code>driver.healthcheck()</Code>
          {t('help.healthcheck.steps.b')}
          <Code>healthy</Code>
          {t('help.healthcheck.steps.c')}
          <Code>unhealthy</Code>
          {t('help.healthcheck.steps.c')}
          <Code>unreachable</Code>
          {t('help.healthcheck.steps.d')}
        </>
      ),
      payload: (
        <>
          <Code>applicationIds</Code>
          {t('help.healthcheck.payload.a')}
          <Code>targetIds</Code>
          {t('help.healthcheck.payload.b')}
        </>
      ),
    },
    cleanup: {
      steps: (
        <>
          {t('help.cleanup.steps.a')}
          <Code>keep</Code>
          {t('help.cleanup.steps.b')}
        </>
      ),
      payload: (
        <>
          <Code>keep</Code>
          {t('help.cleanup.payload.a')}
          <Code>applicationIds</Code>
          {t('help.cleanup.payload.b')}
          <Code>targetIds</Code>.
        </>
      ),
    },
    preflight: {
      steps: (
        <>
          {t('help.preflight.steps.a')}
          <strong>{t('help.preflight.steps.queue')}</strong>
          {t('help.preflight.steps.b')}
          <Code>target:preflight</Code>
          {t('help.preflight.steps.c')}
        </>
      ),
      payload: (
        <>
          <Code>targetIds</Code>
          {t('help.preflight.payload')}
        </>
      ),
    },
  };
}

export function JobsHelp({ label, className, defaultTimeZone }: Props) {
  const t = useT(messages);
  const language = useLanguage();
  const definitions = scheduledJobTypes(language);
  const detail = whatTheyDo(t);
  const strong = (text: string) => <strong className="font-medium text-text">{text}</strong>;

  return (
    <HelpDrawer
      triggerLabel={label ?? t('help.trigger')}
      title={t('help.title')}
      description={t('help.subtitle')}
      className={className}
    >
      <HelpSection icon={Lightbulb} title={t('help.idea.title')}>
        <p>{t('help.idea.p1')}</p>
        <HelpCallout tone="accent">
          {t('help.idea.p2.a')}
          {strong(t('help.idea.p2.strong'))}
          {t('help.idea.p2.b')}
        </HelpCallout>
      </HelpSection>

      <HelpSection icon={CalendarClock} title={t('help.types.title')}>
        <HelpTable
          columns={[
            { key: 'type', label: t('help.types.column.type') },
            { key: 'what', label: t('help.types.column.what') },
            { key: 'payload', label: t('help.types.column.payload') },
          ]}
          rows={SCHEDULED_JOB_TYPES_LIST.map((type) => {
            const definition = definitions[type];
            const rows = detail[type];
            return {
              key: type,
              cells: [
                <div key="type" className="flex flex-col gap-1">
                  <span className="whitespace-nowrap">{definition.label}</span>
                  <code className="mono text-[11px] font-normal text-text-3">
                    {definition.jobName}
                  </code>
                  <span className="text-[11.5px] font-normal text-text-3">
                    {t('help.types.default')}
                    <Code>{definition.defaultCron}</Code>
                  </span>
                </div>,
                <div key="what" className="flex flex-col gap-1.5">
                  <span>{rows.steps}</span>
                  <span className="rounded-md border border-warn-line bg-warn-soft px-2 py-1 text-[11.5px] text-warn-text">
                    {definition.neverDoes}
                  </span>
                </div>,
                rows.payload,
              ],
            };
          })}
        />
      </HelpSection>

      <HelpSection icon={Clock} title={t('help.when.title')}>
        <p>
          {t('help.when.a')}
          {strong(t('help.when.bullmq'))}
          {t('help.when.b')}
          <em>{t('help.when.scheduler')}</em>
          {t('help.when.c')}
          <em>{t('help.when.state')}</em>
          {t('help.when.d')}
        </p>
      </HelpSection>

      <HelpSection icon={Globe} title={t('help.zone.title')}>
        <p>
          {strong(t('help.zone.p1.strong'))}
          {t('help.zone.p1.a')}
          <Code>{'{ pattern, tz }'}</Code>
          {t('help.zone.p1.b')}
          <Code>Europe/Paris</Code>
          {t('help.zone.p1.c')}
        </p>
        <HelpCallout tone="ok">
          {t('help.zone.p2.a')}
          <Code>{defaultTimeZone}</Code>
          {t('help.zone.p2.b')}
        </HelpCallout>
        <HelpCallout tone="warn">
          <strong className="font-medium text-text">
            {t('help.zone.legacy.a')}
            <Code>UTC</Code>
          </strong>
          {t('help.zone.legacy.b', { zone: defaultTimeZone })}
          <Code>tz</Code>
          {t('help.zone.legacy.c')}
        </HelpCallout>
      </HelpSection>

      <HelpSection icon={SlidersHorizontal} title={t('help.modes.title')}>
        <p>{t('help.modes.p1')}</p>
        <p>
          {t('help.modes.p2.a')}
          <Code>*/7 2-5 * * 1,3</Code>
          {t('help.modes.p2.b')}
        </p>
      </HelpSection>

      <HelpSection icon={MousePointerClick} title={t('help.actions.title')}>
        <HelpCallout tone="accent" title={t('help.actions.run')}>
          {t('help.actions.run.a')}
          <Code>{t('help.actions.run.manual')}</Code>
          {t('help.actions.run.b')}
        </HelpCallout>
        <HelpCallout tone="warn" title={t('help.actions.disable')}>
          {t('help.actions.disable.text')}
        </HelpCallout>
        <HelpCallout tone="danger" title={t('help.actions.delete')}>
          {t('help.actions.delete.text')}
        </HelpCallout>
      </HelpSection>

      <HelpSection icon={Gauge} title={t('help.cadence.title')}>
        <HelpTable
          columns={[
            { key: 'job', label: t('help.cadence.column.job'), nowrap: true },
            { key: 'value', label: t('help.cadence.column.value'), tone: 'accent' },
            { key: 'why', label: t('help.cadence.column.why') },
          ]}
          rows={[
            {
              key: 'healthcheck',
              cells: [
                t('help.cadence.healthcheck.job'),
                t('help.cadence.healthcheck.value'),
                <React.Fragment key="why">
                  {t('help.cadence.healthcheck.why.a')}
                  <Code>MaxStartups</Code>
                  {t('help.cadence.healthcheck.why.b')}
                </React.Fragment>,
              ],
            },
            ...(['scan', 'cleanup', 'preflight'] as const).map((job) => ({
              key: job,
              cells: [
                t(`help.cadence.${job}.job`),
                t(`help.cadence.${job}.value`),
                t(`help.cadence.${job}.why`),
              ],
            })),
          ]}
        />
      </HelpSection>

      <HelpSection icon={CodeIcon} title={t('help.syntax.title')}>
        <HelpBlock>{t('help.cheatsheet')}</HelpBlock>
        <HelpCallout tone="neutral">
          {t('help.syntax.note.a')}
          <em>{t('help.syntax.note.before')}</em>
          {t('help.syntax.note.b')}
        </HelpCallout>
      </HelpSection>
    </HelpDrawer>
  );
}
