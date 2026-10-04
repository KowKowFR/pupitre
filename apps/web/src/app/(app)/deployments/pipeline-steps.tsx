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
 * A run's pipeline, as a vertical ladder: one dot per step, the upright that
 * colors up to the current step, the start time on the right. Progress reads on
 * the column itself, without counting check marks; the dot carries the state
 * through its shape (check, cross, dash, spinning ring).
 *
 * A step's name is rendered from its key, not from the label the database froze
 * when queuing the job: without that, a pipeline started in French would stay
 * French in a panel switched to English.
 */
export function PipelineSteps({
  steps,
  format,
  detail,
}: {
  steps: readonly StepView[];
  format: FormatSettings;
  /** One more line under a step (the verdict under the security analysis). */
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
                    {/* UTC, like the log's dates: they compare with the worker's logs. */}
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
