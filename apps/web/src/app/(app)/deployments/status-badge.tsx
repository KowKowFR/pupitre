'use client';

import type { DeploymentStatus } from '@pupitre/core';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { useT } from '@/i18n/client';
import { deployments as messages } from '@/i18n/messages/deployments';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';

/**
 * The six status labels, in the instance's language.
 *
 * A hook replaces the frozen table of before: that one was built when the module
 * loaded, hence before any language context existed. It is also what moves this
 * file to the client side — the badge is already rendered in client components,
 * and the dashboard can show it as is.
 */
function useDeploymentLabels(): Record<DeploymentStatus, string> {
  const t = useT(messages);
  return {
    pending: t('status.pending'),
    running: t('status.running'),
    success: t('status.success'),
    failed: t('status.failed'),
    rolled_back: t('status.rolled_back'),
    destroyed: t('status.destroyed'),
  };
}

/**
 * `rolled_back` is not `failed`.
 *
 * A rolled-back deployment is a deployment that failed **and was recovered
 * from**: the URL answers, the previous version is in service. Painting it red
 * would suggest an outage where the safety net worked. Hence amber: something
 * went wrong, nothing is broken.
 */
const DEPLOYMENT_VARIANT: Record<DeploymentStatus, BadgeProps['variant']> = {
  pending: 'idle',
  running: 'accent',
  success: 'ok',
  failed: 'danger',
  rolled_back: 'warn',
  destroyed: 'outline',
};

/**
 * A run's status chip: a dot and a word, in the state's tone. "In progress" is
 * ultramarine — what is being done.
 */
export function DeploymentStatusBadge({ status }: { status: DeploymentStatus }) {
  const label = useDeploymentLabels();
  return (
    <Badge variant={DEPLOYMENT_VARIANT[status]} dot>
      {label[status]}
    </Badge>
  );
}

/**
 * A run's duration. In progress, it counts up to now — and the server and the
 * browser do not read the clock at the same second: where it is shown, the
 * element carries `suppressHydrationWarning`.
 */
export function formatDuration(from: string | null, to: string | null): string {
  if (!from) return '—';
  const end = to ? new Date(to).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(from).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

/**
 * A deployment's timestamp.
 *
 * The time zone stays **UTC**, and deliberately: these columns compare with
 * worker logs, which are in UTC. The locale, for its part, had no reason to stay
 * frozen — `15/01/2026 14:32:07` on an English panel was a date read the wrong
 * way. It therefore comes from the instance settings, through props, which also
 * guarantees the same string on the server side and on the client side.
 */
export function formatDate(iso: string | null, format: FormatSettings): string {
  return formatDateTimeWith(iso, format, {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'UTC',
  });
}
