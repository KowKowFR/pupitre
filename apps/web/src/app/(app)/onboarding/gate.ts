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
 * **Ce qui commande : le drapeau en base, jamais l'état réel du parc.**
 * Compter les cibles pour décider serait séduisant — « zéro cible, donc
 * installation neuve » — mais faux dans les deux sens. Un panel dont on vient
 * de supprimer la dernière cible repartirait en mode découverte devant son
 * administrateur ; une installation provisionnée par script, elle, serait
 * traînée dans un assistant dont elle n'a que faire. Le drapeau, lui, dit ce
 * qui s'est réellement passé. L'état réel du parc reste utile, mais seulement
 * *dans* l'assistant : il y sert à montrer qu'une étape est déjà satisfaite,
 * pas à décider si l'écran s'affiche.
 */

export type OnboardingGate = {
  state: OnboardingState;
  /** Étapes que cette personne peut réellement accomplir. Vide = hors sujet. */
  steps: OnboardingStepDefinition[];
  /** L'assistant concerne-t-il cette personne ? */
  applies: boolean;
  /** Parcours ouvert : ni terminé, ni abandonné — on peut le reprendre. */
  resumable: boolean;
  /** Jamais proposé à personne. Le seul cas qui justifie une redirection. */
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
    shouldOffer: applies && state.status === 'pending',
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
 * Rend `false` si l'écriture échoue : mieux vaut ne pas proposer l'assistant
 * qu'enfermer quelqu'un dans une boucle de redirections.
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
