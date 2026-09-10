import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { onboardingStep } from '@tp/core';
import { getAppSettings } from '@tp/db';
import { currentAuth } from '@/lib/page-auth';
import { AppHeader } from '@/components/app-header';
import { OnboardingBanner } from './onboarding/onboarding-banner';
import { offerOnboarding, onboardingGate } from './onboarding/gate';

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
   * La redirection n'a lieu qu'une fois, au tout premier affichage — et
   * `offerOnboarding()` change l'état *avant* qu'elle parte, ce qui la rend
   * finie : ce layout enveloppe aussi `/onboarding`, il se réexécute donc à
   * l'arrivée, avec un état qui ne redirige plus. Ensuite, plus jamais de
   * redirection subie : la reprise passe par le bandeau ci-dessous, qu'on peut
   * ignorer. Un écran dont on ne s'échappe pas sur une installation qu'on
   * découvre est un désastre.
   */
  const gate = onboardingGate(auth, settings);
  const offered = gate.shouldOffer ? await offerOnboarding(auth) : false;
  if (offered) redirect('/onboarding');

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
