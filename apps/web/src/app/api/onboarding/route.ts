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
 * Avancement de l'assistant de démarrage.
 *
 * L'assistant lui-même ne crée rien par ici : une cible passe par
 * `POST /api/targets`, un rôle par `POST /api/admin/roles`, les réglages par
 * `PATCH /api/settings`. Cette route ne fait qu'une chose — se souvenir d'où
 * l'on en est. C'est la raison pour laquelle elle existe : sans elle, l'écran
 * aurait été tenté de refaire les créations « en plus simple », et six mois
 * plus tard la validation, l'audit et le preflight auraient divergé.
 *
 * Il n'y a pas de permission `onboarding:*`, et il n'en faut pas : le
 * vocabulaire RBAC est fermé. Le droit d'écrire ici se déduit — on peut
 * enregistrer son avancement si et seulement si au moins une étape de
 * l'assistant nous concerne. Relancer le parcours, en revanche, rebat l'état
 * de toute l'instance : cela exige `settings:manage`.
 */

const patchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), step: z.enum(ONBOARDING_STEPS) }),
  z.object({ action: z.literal('complete'), step: z.enum(ONBOARDING_STEPS) }),
  z.object({ action: z.literal('skip'), step: z.enum(ONBOARDING_STEPS) }),
  z.object({ action: z.literal('finish') }),
  z.object({ action: z.literal('dismiss') }),
  z.object({ action: z.literal('restart') }),
]);

/** 403 explicite : l'assistant ne concerne pas cette personne. */
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
    // Passer n'a de sens que pour une étape qui se passe. Refuser ici plutôt
    // que d'accepter un « skipped » sur « bienvenue », que le récapitulatif
    // présenterait ensuite comme un renoncement.
    if (input.action === 'skip' && !onboardingStep(input.step).optional) {
      // Le titre de l'étape n'est plus dans le catalogue : il se rend ici, dans
      // la langue de l'instance, puis voyage comme une simple variable.
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

  // `goto` est une navigation, pas un fait : l'auditer noierait les entrées qui
  // comptent sous le va-et-vient de quelqu'un qui relit une étape.
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
