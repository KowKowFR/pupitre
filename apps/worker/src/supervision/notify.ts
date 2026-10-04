import {
  HOST_METRIC_CATALOG,
  logAudit,
  type BreachTransition,
  type TargetMetricSample,
} from '@pupitre/db';
import { logger } from '../logger.js';
import { instanceLanguage } from '../language.js';

/**
 * ⟵ **THE SEAM** ⟶
 *
 * The only place in this work where a threshold crossing becomes a message. The
 * sweep observes, the rule decides, this function tells.
 *
 * ── Why it goes through `logAudit()` and nothing else ───────────────────────
 * Rule 6 of the project: a single entry point. And it is not only a matter of
 * discipline — `logAudit()` carries the observer that recognizes an action in the
 * events catalog and queues the delivery to the subscribed channels (SMTP,
 * Telegram, Discord, webhook). Writing the audit **is** therefore the emission:
 * there is no call to the channels factory here, no import of
 * `@pupitre/core/notifications`, exactly like site monitoring
 * (`monitors/notify.ts`). The connection to the catalog fits in two table
 * entries, on the `packages/core/src/notifications/events.ts` side — out of this
 * work's scope, and deliberately left to do.
 *
 * ── What this payload must contain ──────────────────────────────────────────
 * What is not in it cannot be told to the operator. Hence:
 *   — `metric`, `value`, `limitPercent`: enough to write "disk at 92%, above
 *     90%" without reading the database again;
 *   — `peakValue` and `durationSeconds` at recovery: a digest saying "back to
 *     normal after 3 h, 97% at worst" is worth a hundred times a counter;
 *   — `targetName`: a UUID in a Telegram message helps nobody.
 *
 * ── The two anti-flood rules, and where they live ───────────────────────────
 *   1. **The crossing is the event, not the state.** This function is only
 *      called at flips — `evaluateThresholds()` returns nothing as long as
 *      nothing flips. A machine at 92% disk for three days produces one entry,
 *      not 864.
 *   2. **Only once, structurally.** Guaranteed upstream by the partial unique
 *      index on open breaches: no two open episodes on the same machine and the
 *      same metric, hence no two messages — even if the sweep and a manual "Read
 *      now" concluded in the same second.
 *
 * We announce **the return to normal too**. An alert without its counterpart
 * forces a manual check, which is exactly what we wanted to avoid.
 */
export async function notifyBreachTransition(
  target: { id: string; name: string },
  transition: BreachTransition,
  sample: TargetMetricSample,
): Promise<void> {
  const definition = HOST_METRIC_CATALOG[transition.metric];
  const breach = transition.breach;
  // The alert is composed here, once: in the instance's language.
  const language = await instanceLanguage();

  const durationSeconds = breach.resolvedAt
    ? Math.max(0, Math.round((breach.resolvedAt.getTime() - breach.startedAt.getTime()) / 1000))
    : null;

  const action =
    transition.kind === 'opened' ? 'target.threshold.breached' : 'target.threshold.cleared';

  await logAudit({
    action,
    resourceType: 'target',
    resourceId: target.id,
    before: { limitPercent: breach.limitPercent },
    after: {
      targetName: target.name,
      metric: transition.metric,
      metricLabel: definition.label(language),
      // The ready-made sentence: "disk /opt/bootstrap at 92.4%". The catalog composes
      // it, because it is the only one that knows what the value means.
      detail: definition.describe(transition.value, sample, language),
      value: transition.value,
      limitPercent: breach.limitPercent,
      peakValue: breach.peakValue,
      samples: breach.samples,
      breachId: breach.id,
      startedAt: breach.startedAt.toISOString(),
      resolvedAt: breach.resolvedAt?.toISOString() ?? null,
      durationSeconds,
      // `threshold_disabled`: the episode closed because the threshold was turned off,
      // not because the machine is better. Saying so avoids false relief.
      reason: transition.reason,
      thresholdOrigin: transition.threshold.origin,
    },
  });

  logger.info(
    {
      targetId: target.id,
      metric: transition.metric,
      kind: transition.kind,
      value: transition.value,
      limitPercent: breach.limitPercent,
      reason: transition.reason,
    },
    transition.kind === 'opened' ? 'threshold crossed' : 'threshold met again',
  );
}
