import Link from 'next/link';
import {
  DATE_STYLES,
  SUPPORTED_LOCALES,
  presentOnboardingSteps,
  supportedTimeZones,
  type RoleKey,
} from '@tp/core';
import { getAppSettings, listRoles } from '@tp/db';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { requirePageSession } from '@/lib/page-auth';
import { onboardingEnvironment, onboardingGate } from '@/lib/onboarding-gate';
import { OnboardingWizard } from './onboarding-wizard';

export const dynamic = 'force-dynamic';

/**
 * Assistant de démarrage.
 *
 * Aucune donnée n'est créée ici : chaque étape appelle la route d'API que
 * l'écran normal appelle déjà, avec le même formulaire quand il existe. Cette
 * page ne fait que rassembler le contexte dont ces formulaires ont besoin —
 * exactement comme le font `/targets/new`, `/admin/roles` et `/admin/settings`.
 */
export default async function OnboardingPage() {
  const auth = await requirePageSession('/onboarding');
  const record = await getAppSettings();
  const gate = onboardingGate(auth, record.settings);

  // Un observateur ne se voit proposer aucune étape : plutôt qu'un 403 sur un
  // écran qui ne lui était pas destiné, on lui dit ce qu'il en est et où aller.
  if (!gate.applies) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          eyebrow="Prise en main"
          title="Rien à configurer ici"
          description="L'assistant de démarrage ne propose que des étapes qu'on peut réellement accomplir. Aucune ne relève de vos permissions actuelles."
        />
        <EmptyState
          title="Cet assistant ne vous concerne pas"
          hint="Déclarer une cible, créer un rôle ou un compte, régler l'instance : chacune de ces actions demande une permission que votre rôle ne porte pas. Une étape qui finirait en 403 est pire qu'une étape absente."
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/">Retour au tableau de bord</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const environment = await onboardingEnvironment(auth);
  // Les rôles attribuables viennent de la base, comme sur /admin/users : un
  // rôle créé à l'étape précédente doit être proposé à la suivante.
  const roleKeys = auth.can('role:read')
    ? (await listRoles()).map((role) => role.key)
    : (['viewer'] as RoleKey[]);

  return (
    <div className="flex flex-col gap-6">
      <OnboardingWizard
        state={gate.state}
        steps={presentOnboardingSteps(gate.state, gate.steps)}
        environment={environment}
        settings={record.settings}
        aiApiKeyConfigured={record.aiApiKeyConfigured}
        aiApiKeyLast4={record.aiApiKeyLast4}
        timezones={supportedTimeZones()}
        locales={[...SUPPORTED_LOCALES]}
        dateStyles={[...DATE_STYLES]}
        roleKeys={roleKeys}
        canRunPreflight={auth.can('target:update')}
      />
    </div>
  );
}
