import Link from 'next/link';
import {
  DATE_STYLES,
  TRANSLATED_LOCALES,
  presentOnboardingSteps,
  supportedTimeZones,
  type RoleKey,
  type SupportedLocale,
} from '@pupitre/core';
import { getAppSettings, listRoles } from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { getT } from '@/i18n/server';
import { onboarding } from '@/i18n/messages/onboarding';
import { requirePageSession } from '@/lib/page-auth';
import { canSendAccountMail } from '@/lib/account-mail';
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
  const t = await getT(onboarding);

  // Un observateur ne se voit proposer aucune étape : plutôt qu'un 403 sur un
  // écran qui ne lui était pas destiné, on lui dit ce qu'il en est et où aller.
  if (!gate.applies) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t('notApplicable.title')} description={t('notApplicable.description')} />
        <EmptyState
          title={t('notApplicable.empty.title')}
          hint={t('notApplicable.empty.hint')}
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/">{t('notApplicable.back')}</Link>
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

  /**
   * Même liste qu'à la section Régionalisation, et pour la même raison : le
   * sélecteur n'offre que les langues que le panel parle réellement, mais il
   * n'escamote jamais la valeur en place. Une instance restée sur `de-DE`
   * verrait sinon une liste sans ce qu'elle affiche, et le premier
   * enregistrement changerait sa locale sans que personne l'ait demandé.
   */
  const offered: SupportedLocale[] = [...TRANSLATED_LOCALES];
  const locales = offered.includes(record.settings.locale)
    ? offered
    : [record.settings.locale, ...offered];

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
        locales={locales}
        dateStyles={[...DATE_STYLES]}
        roleKeys={roleKeys}
        canRunPreflight={auth.can('target:update')}
        canInvite={await canSendAccountMail()}
      />
    </div>
  );
}
