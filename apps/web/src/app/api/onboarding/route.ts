import {
  ONBOARDING_STEPS,
  applyOnboardingAction,
  onboardingApplies,
  onboardingStep,
  onboardingStepsFor,
  presentOnboardingSteps,
  type OnboardingAction,
} from '@pupitre/core';
import { getAppSettings, logAudit, updateOnboardingState } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getT } from '@/i18n/server';
import { onboarding } from '@/i18n/messages/onboarding';
import { HttpError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requireSession, type AuthContext } from '@/lib/rbac';
import { onboardingEnvironment } from '@/lib/onboarding-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The onboarding assistant's progress.
 *
 * The assistant itself creates nothing through here: a target goes through
 * `POST /api/targets`, a role through `POST /api/admin/roles`, the settings
 * through `PATCH /api/settings`. This route only does one thing — remember where
 * one stands. That is why it exists: without it, the screen would have been
 * tempted to redo the creations "more simply", and six months later the
 * validation, the audit and the preflight would have diverged.
 *
 * There is no `onboarding:*` permission, and none is needed: the RBAC vocabulary
 * is closed. The right to write here is deduced — one can save one's progress if
 * and only if at least one step of the assistant concerns one. Restarting the
 * journey, on the other hand, resets the whole instance's state: it requires
 * `settings:manage`.
 */

const patchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), step: z.enum(ONBOARDING_STEPS) }),
  z.object({ action: z.literal('complete'), step: z.enum(ONBOARDING_STEPS) }),
  z.object({ action: z.literal('skip'), step: z.enum(ONBOARDING_STEPS) }),
  z.object({ action: z.literal('finish') }),
  z.object({ action: z.literal('dismiss') }),
  z.object({ action: z.literal('restart') }),
]);

/** An explicit 403: the assistant does not concern this person. */
function assertApplies(auth: AuthContext): void {
  if (onboardingApplies(auth.can)) return;
  throw new HttpError(403, 'onboarding_not_applicable', msg(onboarding, 'error.notApplicable'));
}

export const GET = apiRoute(async (request) => {
  const auth = await requireSession(request);
  const [{ settings }, environment] = await Promise.all([
    getAppSettings(),
    onboardingEnvironment(auth),
  ]);

  const steps = onboardingStepsFor(auth.can);

  return NextResponse.json({
    state: settings.onboarding,
    applies: onboardingApplies(auth.can),
    steps: presentOnboardingSteps(settings.onboarding, steps),
    environment,
  });
});

export const PATCH = apiRoute(async (request) => {
  const auth = await requireSession(request);
  const input = await readJsonBody(request, patchSchema);

  const steps = onboardingStepsFor(auth.can);

  if (input.action === 'restart') {
    if (!auth.can('settings:manage')) {
      throw new HttpError(403, 'forbidden', msg(onboarding, 'error.restartForbidden'));
    }
  } else {
    assertApplies(auth);
  }

  if ('step' in input) {
    const eligible = steps.some((step) => step.id === input.step);
    if (!eligible) {
      throw new HttpError(
        403,
        'onboarding_step_forbidden',
        msg(onboarding, 'error.stepForbidden', { step: input.step }),
      );
    }
    // Skipping only makes sense for a step that can be skipped. Refuse here rather
    // than accept a "skipped" on "welcome", which the summary would then present as a
    // renunciation.
    if (input.action === 'skip' && !onboardingStep(input.step).optional) {
      // The step's title is no longer in the catalog: it is rendered here, in the
      // instance's language, then travels as a mere variable.
      const t = await getT(onboarding);
      throw new HttpError(
        409,
        'step_not_optional',
        msg(onboarding, 'error.stepNotOptional', { title: t(`step.${input.step}.title`) }),
      );
    }
  }

  const action: OnboardingAction =
    input.action === 'goto'
      ? { kind: 'goto', step: input.step }
      : input.action === 'complete'
        ? { kind: 'complete', step: input.step }
        : input.action === 'skip'
          ? { kind: 'skip', step: input.step }
          : input.action === 'finish'
            ? { kind: 'finish' }
            : input.action === 'dismiss'
              ? { kind: 'dismiss' }
              : { kind: 'restart' };

  const { before, after } = await updateOnboardingState(
    (current) => applyOnboardingAction(current, action, steps),
    auth.userId,
  );

  // `goto` is a navigation, not a fact: auditing it would drown the entries that
  // matter under the back and forth of someone rereading a step.
  const AUDITED: Partial<Record<typeof input.action, string>> = {
    complete: 'onboarding.step.completed',
    skip: 'onboarding.step.skipped',
    finish: 'onboarding.completed',
    dismiss: 'onboarding.dismissed',
    restart: 'onboarding.restarted',
  };

  const auditAction = AUDITED[input.action];
  if (auditAction) {
    await logAudit({
      actorId: auth.userId,
      action: auditAction,
      resourceType: 'settings',
      resourceId: 'onboarding',
      before: { status: before.status, completed: before.completed, skipped: before.skipped },
      after: {
        status: after.status,
        currentStep: after.currentStep,
        completed: after.completed,
        skipped: after.skipped,
        runs: after.runs,
        ...('step' in input ? { step: input.step } : {}),
      },
      ip: auth.ip,
    });
  }

  return NextResponse.json({
    state: after,
    applies: onboardingApplies(auth.can),
    steps: presentOnboardingSteps(after, steps),
  });
});
