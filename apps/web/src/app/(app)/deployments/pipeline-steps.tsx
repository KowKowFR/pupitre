'use client';

import type { ReactNode } from 'react';
import { Check, Minus, X } from 'lucide-react';
import { deploymentStepLabel, type StepStatus } from '@pupitre/core';
import { useLanguage, useT } from '@/i18n/client';
import { deployments as messages } from '@/i18n/messages/deployments';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import { cn } from '@/lib/utils';
import { formatDuration } from './status-badge';

export type StepView = {
  key: string;
  label: string;
  status: StepStatus;
  order: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

const STEP_CLASS: Record<StepStatus, string> = {
  pending: '',
  running: 'run',
  success: 'done',
  failed: 'fail',
  skipped: 'skip',
};

/**
 * Le pipeline d'un run, en échelle verticale : une pastille par étape, le
 * montant qui se colore jusqu'à l'étape courante, l'heure de départ à droite.
 * L'avancement se lit sur la colonne elle-même, sans compter les coches ; la
 * pastille porte l'état par sa forme (coche, croix, trait, anneau qui tourne).
 *
 * Le nom d'une étape se rend à partir de sa clé, pas du libellé que la base a
 * figé au moment d'enfiler le job : sans cela, un pipeline lancé en français
 * resterait français dans un panel passé à l'anglais.
 */
export function PipelineSteps({
  steps,
  format,
  detail,
}: {
  steps: readonly StepView[];
  format: FormatSettings;
  /** Une ligne de plus sous une étape (le verdict sous l'analyse de sécurité). */
  detail?: (step: StepView) => ReactNode;
}) {
  const t = useT(messages);
  const language = useLanguage();

  return (
    <ol className="steps">
      {steps.map((step) => {
        const extra = detail?.(step);
        return (
          <li key={step.key} className={cn('step', STEP_CLASS[step.status])}>
            <span className="dot" role="img" aria-label={t(`step.${step.status}`)}>
              {step.status === 'success' ? (
                <Check aria-hidden />
              ) : step.status === 'failed' ? (
                <X aria-hidden />
              ) : step.status === 'skipped' ? (
                <Minus aria-hidden />
              ) : step.status === 'running' ? (
                <span className="spinner motion-reduce:animate-none" aria-hidden />
              ) : null}
            </span>
            <div className="body">
              <span className="ttl">
                <span
                  className={cn(
                    'min-w-0',
                    step.status === 'running' && 'text-accent-text',
                    step.status === 'pending' && 'font-normal text-text-2',
                  )}
                >
                  {deploymentStepLabel(step.key, language, step.label)}
                </span>
                {step.startedAt && step.status !== 'pending' && step.status !== 'skipped' ? (
                  <span
                    className="tm"
                    title={formatDuration(step.startedAt, step.finishedAt)}
                    suppressHydrationWarning
                  >
                    {/* UTC, comme les dates du journal : elles se comparent aux logs du worker. */}
                    {formatDateTimeWith(step.startedAt, format, {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                      timeZone: 'UTC',
                    })}
                  </span>
                ) : null}
              </span>
              {step.error ? (
                <div className="codeblock mt-1 border-danger-line bg-danger-soft text-[11.5px] break-words whitespace-normal text-danger-text">
                  {step.error}
                </div>
              ) : null}
              {extra}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
