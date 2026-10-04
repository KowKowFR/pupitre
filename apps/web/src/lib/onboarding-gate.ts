import 'server-only';
import {
  applyOnboardingAction,
  isOnboardingSettled,
  onboardingApplies,
  onboardingStepsFor,
  type AppSettings,
  type OnboardingState,
  type OnboardingStepDefinition,
} from '@pupitre/core';
import {
  count,
  getAppSettings,
  getDb,
  listApplications,
  listRolesWithPermissions,
  listTargets,
  logAudit,
  updateOnboardingState,
  users as usersTable,
} from '@pupitre/db';
import { logger } from '@/lib/logger';
import type { AuthContext } from '@/lib/rbac';

/**
 * Deciding whether to show the onboarding assistant.
 *
 * It cannot be decided in `proxy.ts`: that one runs on Edge and only reads a
 * cookie, it has no access to `app_settings`. It therefore belongs to `(app)`'s
 * server layout, which already loads the authentication and the settings — the
 * only two things it depends on.
 *
 * **The rule fits in one sentence: as long as the journey is not settled, one
 * comes back to it.** `pending` as well as `in_progress` send back to the
 * assistant, from any page. Only `completed` and `dismissed` release from it.
 *
 * There is therefore only one exit before the end: abandoning, and it goes
 * through a confirmation that says what one leaves behind. It is deliberate — a
 * "Later" button pressed by reflex is not a choice, and a half-configured
 * installation discovered three weeks later costs more than thirty seconds of
 * reading.
 *
 * We do not count the targets to decide. The flag says what really happened; the
 * fleet, for its part, can be empty for good reasons. The fleet's real state
 * serves elsewhere: in the assistant, to show that a step is already satisfied.
 */

export type OnboardingGate = {
  state: OnboardingState;
  /** The steps this person can really accomplish. Empty = not concerned. */
  steps: OnboardingStepDefinition[];
  /** Does the assistant concern this person? */
  applies: boolean;
  /** An open journey: neither finished nor abandoned — it can be resumed. */
  resumable: boolean;
  /** L'assistant doit s'imposer maintenant. */
  shouldOffer: boolean;
};

export function onboardingGate(auth: AuthContext, settings: AppSettings): OnboardingGate {
  const state = settings.onboarding;
  const applies = onboardingApplies(auth.can);
  const steps = onboardingStepsFor(auth.can);
  const settled = isOnboardingSettled(state);

  return {
    state,
    steps,
    applies,
    resumable: applies && !settled,
    shouldOffer: applies && !settled,
  };
}

/**
 * Marks the assistant as offered, then lets the caller redirect.
 *
 * The order is not negotiable, and it is what makes the redirect finite: `(app)`'s
 * layout also wraps `/onboarding`, so redirecting without changing state would
 * loop forever. The `pending → in_progress` transition is exactly the fact we
 * want to record — "the assistant was shown" — and it is enough for the next pass
 * not to redirect any more.
 *
 * Returns `false` when nothing changed — the state was already started. **It is
 * not a reason not to redirect**: on an instance without a target, the screen
 * imposes itself whether the transition took place or not. The caller decides.
 */
export async function offerOnboarding(auth: AuthContext): Promise<boolean> {
  try {
    const { before, after } = await updateOnboardingState(
      (current) => applyOnboardingAction(current, { kind: 'offer' }, onboardingStepsFor(auth.can)),
      auth.userId,
    );

    if (before.status === after.status) return false;

    await logAudit({
      actorId: auth.userId,
      action: 'onboarding.offered',
      resourceType: 'settings',
      resourceId: 'onboarding',
      before: { status: before.status },
      after: { status: after.status, currentStep: after.currentStep, runs: after.runs },
      ip: auth.ip,
    });
    return true;
  } catch (error) {
    logger.error({ err: error }, 'the onboarding assistant could not be marked as offered');
    return false;
  }
}

/**
 * The installation's real state, as the assistant is allowed to show it to this
 * person. `null` where the read permission is missing — the assistant does not
 * serve as a back channel to count what one is not allowed to see.
 *
 * It decides nothing: it serves to say "you already have two targets" so that an
 * already configured installation can settle the assistant in two clicks instead
 * of redoing what exists.
 */
export type OnboardingEnvironment = {
  targets: number | null;
  applications: number | null;
  roles: number | null;
  users: number | null;
  aiApiKeyConfigured: boolean | null;
};

export async function onboardingEnvironment(auth: AuthContext): Promise<OnboardingEnvironment> {
  const [targets, applications, roles, users, settings] = await Promise.all([
    auth.can('target:read') ? listTargets() : Promise.resolve(null),
    auth.can('application:read') ? listApplications() : Promise.resolve(null),
    auth.can('role:read') ? listRolesWithPermissions() : Promise.resolve(null),
    auth.can('user:read')
      ? getDb().select({ value: count() }).from(usersTable)
      : Promise.resolve(null),
    auth.can('settings:read') ? getAppSettings() : Promise.resolve(null),
  ]);

  return {
    targets: targets?.length ?? null,
    applications: applications?.length ?? null,
    roles: roles?.length ?? null,
    users: users?.[0]?.value ?? null,
    aiApiKeyConfigured: settings?.aiApiKeyConfigured ?? null,
  };
}
