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
 * **La règle tient en une phrase : tant que le parcours n'est pas soldé, on y
 * revient.** `pending` comme `in_progress` renvoient à l'assistant, depuis
 * n'importe quelle page. Seuls `completed` et `dismissed` en libèrent.
 *
 * Il n'y a donc qu'une seule sortie avant la fin : l'abandon, et il passe par
 * une confirmation qui dit ce qu'on laisse derrière soi. C'est délibéré — un
 * bouton « Plus tard » qu'on presse par réflexe n'est pas un choix, et une
 * installation à moitié configurée qu'on découvre trois semaines plus tard
 * coûte plus cher que trente secondes de lecture.
 *
 * On ne compte pas les cibles pour décider. Le drapeau dit ce qui s'est
 * réellement passé ; le parc, lui, peut être vide pour de bonnes raisons.
 * L'état réel du parc sert ailleurs : dans l'assistant, à montrer qu'une
 * étape est déjà satisfaite.
 */

export type OnboardingGate = {
  state: OnboardingState;
  /** Étapes que cette personne peut réellement accomplir. Vide = hors sujet. */
  steps: OnboardingStepDefinition[];
  /** L'assistant concerne-t-il cette personne ? */
  applies: boolean;
  /** Parcours ouvert : ni terminé, ni abandonné — on peut le reprendre. */
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
