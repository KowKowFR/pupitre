'use client';

import { CircleHelp } from 'lucide-react';
import { SCHEDULED_JOB_TYPES_LIST, scheduledJobTypes } from '@pupitre/core/schedule';
import type { Translate as CoreTranslate } from '@pupitre/core';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useLanguage, useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { jobs as messages } from '@/i18n/messages/jobs';
import { cn } from '@/lib/utils';

/**
 * Aide sur les tâches planifiées — contenu statique, aucune donnée serveur.
 *
 * Même parti pris que `components/appspec-help.tsx` : le composant `ui/dialog`
 * reste neutre, tout ce qui parle d'ordonnancement vit ici. Chaque phrase suit
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-text text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-surface-2 text-text rounded px-1 py-0.5 font-mono text-[0.8em]">
      {children}
    </code>
  );
}

function ScrollableTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[34rem] border-collapse text-left text-xs">{children}</table>
    </div>
  );
}

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

export function JobsHelpDialog({ label, className, defaultTimeZone }: Props) {
  const t = useT(messages);
  const tc = useT(common);
  const language = useLanguage();
  const definitions = scheduledJobTypes(language);
  const detail = whatTheyDo(t);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className={cn('btn btn-ghost', className)}>
          <CircleHelp aria-hidden />
          {label ?? t('help.trigger')}
        </button>
      </DialogTrigger>

      <DialogContent size="xwide">
        <DialogHeader icon={<CircleHelp />} tone="accent">
          <DialogTitle>{t('help.title')}</DialogTitle>
          <DialogDescription>{t('help.subtitle')}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-6 text-sm">
          <Section title={t('help.idea.title')}>
            <p className="text-text-2">{t('help.idea.p1')}</p>
            <p className="text-text-2">
              {t('help.idea.p2.a')}
              <strong className="text-text font-medium">{t('help.idea.p2.strong')}</strong>
              {t('help.idea.p2.b')}
            </p>
          </Section>

          <Section title={t('help.types.title')}>
            <ScrollableTable>
              <thead className="bg-surface-2 text-text-2">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('help.types.column.type')}</th>
                  <th className="px-3 py-2 font-medium">{t('help.types.column.what')}</th>
                  <th className="px-3 py-2 font-medium">{t('help.types.column.payload')}</th>
                </tr>
              </thead>
              <tbody>
                {SCHEDULED_JOB_TYPES_LIST.map((type) => {
                  const definition = definitions[type];
                  const rows = detail[type];
                  return (
                    <tr key={type} className="border-t align-top">
                      <td className="px-3 py-2">
                        <div className="text-text font-medium whitespace-nowrap">
                          {definition.label}
                        </div>
                        <code className="text-text-2 font-mono text-[0.7rem]">
                          {definition.jobName}
                        </code>
                        <div className="text-text-2 mt-1 text-[0.7rem]">
                          {t('help.types.default')}
                          <Code>{definition.defaultCron}</Code>
                        </div>
                      </td>
                      <td className="text-text-2 px-3 py-2">
                        {rows.steps}
                        <div className="text-text/80 mt-1.5 text-[0.7rem]">
                          {definition.neverDoes}
                        </div>
                      </td>
                      <td className="text-text-2 px-3 py-2">{rows.payload}</td>
                    </tr>
                  );
                })}
              </tbody>
            </ScrollableTable>
          </Section>

          <Section title={t('help.when.title')}>
            <p className="text-text-2">
              {t('help.when.a')}
              <strong className="text-text font-medium">{t('help.when.bullmq')}</strong>
              {t('help.when.b')}
              <em>{t('help.when.scheduler')}</em>
              {t('help.when.c')}
              <em>{t('help.when.state')}</em>
              {t('help.when.d')}
            </p>
          </Section>

          <Section title={t('help.zone.title')}>
            <p className="text-text-2">
              <strong className="text-text font-medium">{t('help.zone.p1.strong')}</strong>
              {t('help.zone.p1.a')}
              <Code>{'{ pattern, tz }'}</Code>
              {t('help.zone.p1.b')}
              <Code>Europe/Paris</Code>
              {t('help.zone.p1.c')}
            </p>
            <p className="text-text-2">
              {t('help.zone.p2.a')}
              <Code>{defaultTimeZone}</Code>
              {t('help.zone.p2.b')}
            </p>
            <div className="bg-surface-2/40 rounded-md border px-3 py-2">
              <p className="text-text-2 text-xs">
                <strong className="text-text font-medium">
                  {t('help.zone.legacy.a')}
                  <Code>UTC</Code>
                </strong>
                {t('help.zone.legacy.b', { zone: defaultTimeZone })}
                <Code>tz</Code>
                {t('help.zone.legacy.c')}
              </p>
            </div>
          </Section>

          <Section title={t('help.modes.title')}>
            <p className="text-text-2">{t('help.modes.p1')}</p>
            <p className="text-text-2">
              {t('help.modes.p2.a')}
              <Code>*/7 2-5 * * 1,3</Code>
              {t('help.modes.p2.b')}
            </p>
          </Section>

          <Section title={t('help.actions.title')}>
            <ul className="text-text-2 list-disc space-y-1.5 pl-5">
              <li>
                <strong className="text-text font-medium">{t('help.actions.run')}</strong>
                {t('help.actions.run.a')}
                <Code>{t('help.actions.run.manual')}</Code>
                {t('help.actions.run.b')}
              </li>
              <li>
                <strong className="text-text font-medium">{t('help.actions.disable')}</strong>
                {t('help.actions.disable.text')}
              </li>
              <li>
                <strong className="text-text font-medium">{t('help.actions.delete')}</strong>
                {t('help.actions.delete.text')}
              </li>
            </ul>
          </Section>

          <Section title={t('help.cadence.title')}>
            <ScrollableTable>
              <thead className="bg-surface-2 text-text-2">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('help.cadence.column.job')}</th>
                  <th className="px-3 py-2 font-medium">{t('help.cadence.column.value')}</th>
                  <th className="px-3 py-2 font-medium">{t('help.cadence.column.why')}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t align-top">
                  <td className="px-3 py-2 whitespace-nowrap">
                    {t('help.cadence.healthcheck.job')}
                  </td>
                  <td className="text-text-2 px-3 py-2">{t('help.cadence.healthcheck.value')}</td>
                  <td className="text-text-2 px-3 py-2">
                    {t('help.cadence.healthcheck.why.a')}
                    <Code>MaxStartups</Code>
                    {t('help.cadence.healthcheck.why.b')}
                  </td>
                </tr>
                <tr className="border-t align-top">
                  <td className="px-3 py-2 whitespace-nowrap">{t('help.cadence.scan.job')}</td>
                  <td className="text-text-2 px-3 py-2">{t('help.cadence.scan.value')}</td>
                  <td className="text-text-2 px-3 py-2">{t('help.cadence.scan.why')}</td>
                </tr>
                <tr className="border-t align-top">
                  <td className="px-3 py-2 whitespace-nowrap">{t('help.cadence.cleanup.job')}</td>
                  <td className="text-text-2 px-3 py-2">{t('help.cadence.cleanup.value')}</td>
                  <td className="text-text-2 px-3 py-2">{t('help.cadence.cleanup.why')}</td>
                </tr>
                <tr className="border-t align-top">
                  <td className="px-3 py-2 whitespace-nowrap">{t('help.cadence.preflight.job')}</td>
                  <td className="text-text-2 px-3 py-2">{t('help.cadence.preflight.value')}</td>
                  <td className="text-text-2 px-3 py-2">{t('help.cadence.preflight.why')}</td>
                </tr>
              </tbody>
            </ScrollableTable>
          </Section>

          <Section title={t('help.syntax.title')}>
            <pre className="codeblock">
              <code>{t('help.cheatsheet')}</code>
            </pre>
            <p className="text-text-2 text-xs">
              {t('help.syntax.note.a')}
              <em>{t('help.syntax.note.before')}</em>
              {t('help.syntax.note.b')}
            </p>
          </Section>
        </DialogBody>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" type="button">
              {tc('close')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
