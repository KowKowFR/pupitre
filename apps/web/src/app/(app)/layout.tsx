import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { onboardingStep } from '@pupitre/core';
import { getAppSettings } from '@pupitre/db';
import { currentAuth } from '@/lib/page-auth';
import { AppHeader } from '@/components/app-header';
import { OnboardingBanner } from '@/components/onboarding-banner';
import { offerOnboarding, onboardingGate } from '@/lib/onboarding-gate';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const auth = await currentAuth();
  if (!auth) redirect('/login');

  const { settings } = await getAppSettings();

  /**
   * L'assistant de démarrage se décide ici, et nulle part ailleurs : c'est le
   * seul endroit du parcours authentifié qui dispose à la fois de la session et
   * des paramètres d'instance. `proxy.ts` ne verrait qu'un cookie.
   *
   * La redirection ne peut pas boucler : `/onboarding` vit dans son propre
   * groupe de routes, ce layout ne l'enveloppe pas. C'est aussi ce qui lui
   * donne une coquille sans rail de navigation.
   *
   * Elle s'impose dans deux cas — assistant jamais montré, ou instance sans
   * aucune cible. La porte de sortie reste l'abandon explicite, et le bandeau
   * ci-dessous suffit ensuite à reprendre le parcours sans le subir.
   */
  const gate = onboardingGate(auth, settings);
  if (gate.shouldOffer) {
    // On enregistre le fait que l'assistant a été montré, mais la redirection
    // ne dépend pas de cette écriture : une instance sans cible doit y être
    // renvoyée même quand l'état n'a plus rien à changer.
    await offerOnboarding(auth);
    redirect('/onboarding');
  }

  const done = gate.steps.filter(
    (step) => step.requires !== null && gate.state.completed.includes(step.id),
  ).length;
  const actionable = gate.steps.filter((step) => step.requires !== null).length;

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)]">
      <AppHeader
        email={auth.email}
        name={auth.name}
        roles={auth.roles}
        canManageUsers={auth.can('user:manage')}
        canManageRoles={auth.can('role:manage')}
        canReadAudit={auth.can('audit:read')}
        canReadJobs={auth.can('job:read')}
        canReadMonitors={auth.can('monitor:read')}
        canManageSettings={auth.can('settings:read')}
        instanceName={settings.instanceName}
        instanceTagline={settings.instanceTagline}
      />
      <div className="min-w-0">
        <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-9">
          {gate.resumable ? (
            <OnboardingBanner
              stepTitle={onboardingStep(gate.state.currentStep).title}
              done={done}
              total={actionable}
            />
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}
