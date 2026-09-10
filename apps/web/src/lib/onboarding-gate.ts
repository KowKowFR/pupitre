import 'server-only';
import {
  applyOnboardingAction,
  isOnboardingSettled,
  onboardingApplies,
  onboardingStepsFor,
  type AppSettings,
  type OnboardingState,
  type OnboardingStepDefinition,
} from '@tp/core';
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
} from '@tp/db';
import { logger } from '@/lib/logger';
import type { AuthContext } from '@/lib/rbac';

/**
 * Décision d'affichage de l'assistant de démarrage.
 *
 * Elle ne peut pas se prendre dans `proxy.ts` : celui-ci tourne en Edge et ne
 * lit qu'un cookie, il n'a aucun accès à `app_settings`. Elle appartient donc
 * au layout serveur de `(app)`, qui charge déjà l'authentification et les
 * paramètres — les deux seules choses dont elle dépend.
 *
 * **Deux conditions, et il suffit de l'une d'elles.**
 *
 * 1. Le drapeau en base vaut `pending` : l'assistant n'a jamais été montré.
 * 2. L'instance n'a **aucune cible** : elle ne peut rien faire, quoi qu'en
 *    dise le drapeau. Un panel sans cible ne déploie pas ; l'y laisser errer
 *    entre des écrans vides ne rend service à personne.
 *
 * La seconde condition cède devant un abandon explicite. C'est la porte de
 * sortie, et elle est nécessaire : sans elle, quelqu'un qui veut simplement
 * regarder le panel avant de brancher une machine serait ramené à l'assistant
 * à chaque page. « Forcer » ne doit pas vouloir dire « enfermer ».
 *
 * Le nombre de cibles ne sert qu'ici, à décider si l'écran s'impose. Dans
 * l'assistant lui-même, l'état réel du parc sert à autre chose : montrer
 * qu'une étape est déjà satisfaite.
 */

export type OnboardingGate = {
  state: OnboardingState;
  /** Étapes que cette personne peut réellement accomplir. Vide = hors sujet. */
  steps: OnboardingStepDefinition[];
  /** L'assistant concerne-t-il cette personne ? */
  applies: boolean;
  /** Parcours ouvert : ni terminé, ni abandonné — on peut le reprendre. */
  resumable: boolean;
  /** Aucune cible déclarée : l'instance ne peut rien faire en l'état. */
  unconfigured: boolean;
  /** L'assistant doit s'imposer maintenant. */
  shouldOffer: boolean;
};

export async function onboardingGate(
  auth: AuthContext,
  settings: AppSettings,
): Promise<OnboardingGate> {
  const state = settings.onboarding;
  const applies = onboardingApplies(auth.can);
  const steps = onboardingStepsFor(auth.can);
  const settled = isOnboardingSettled(state);

  // Une cible suffit à considérer l'instance configurée : c'est le minimum
  // sans lequel rien d'autre n'est possible. On ne compte que si la question
  // se pose encore — inutile d'interroger la base à chaque page une fois
  // l'assistant soldé.
  const unconfigured =
    applies && state.status !== 'dismissed' && (await listTargets()).length === 0;

  return {
    state,
    steps,
    applies,
    unconfigured,
    resumable: applies && !settled,
    shouldOffer: applies && (state.status === 'pending' || unconfigured),
  };
}

/**
 * Marque l'assistant comme proposé, puis laisse l'appelant rediriger.
 *
 * L'ordre n'est pas négociable, et c'est ce qui rend la redirection finie : le
 * layout de `(app)` enveloppe aussi `/onboarding`, donc rediriger sans changer
 * d'état bouclerait indéfiniment. La transition `pending → in_progress` est
 * exactement le fait qu'on cherche à enregistrer — « l'assistant a été montré »
 * — et elle suffit à ce que la passe suivante ne redirige plus.
 *
 * Rend `false` quand rien n'a changé — l'état était déjà entamé. **Ce n'est
 * pas un motif de ne pas rediriger** : sur une instance sans cible, l'écran
 * s'impose que la transition ait eu lieu ou non. L'appelant décide.
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
    logger.error({ err: error }, "l'assistant de démarrage n'a pas pu être marqué comme proposé");
    return false;
  }
}

/**
 * État réel de l'installation, tel que l'assistant a le droit de le montrer à
 * cette personne. `null` là où la permission de lecture manque — l'assistant
 * ne sert pas de canal détourné pour compter ce qu'on n'a pas le droit de voir.
 *
 * Il ne décide de rien : il sert à dire « vous avez déjà deux cibles » pour
 * qu'une installation déjà configurée puisse solder l'assistant en deux clics
 * au lieu de refaire ce qui existe.
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
