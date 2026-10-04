import Link from 'next/link';
import {
  DATE_STYLES,
  TRANSLATED_LOCALES,
  presentOnboardingSteps,
  supportedTimeZones,
  type RoleKey,
  type SupportedLocale,
} from '@pupitre/core';
import { getAppSettings, listRoles, listTargets } from '@pupitre/db';
import { formatSettingsOf } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { getT } from '@/i18n/server';
import { onboarding } from '@/i18n/messages/onboarding';
import { requirePageSession } from '@/lib/page-auth';
import { canSendAccountMail } from '@/lib/account-mail';
import { onboardingEnvironment, onboardingGate } from '@/lib/onboarding-gate';
import { OnboardingTopbar } from '../onboarding-topbar';
import { OnboardingWizard } from './onboarding-wizard';

export const dynamic = 'force-dynamic';

/**
 * The onboarding assistant.
 *
 * No data is created here: each step calls the API route the normal screen
 * already calls, with the same form when there is one. This page only gathers
 * the context those forms need — exactly as `/targets/new`, `/admin/roles` and
 * `/admin/settings` do.
 */
export default async function OnboardingPage() {
  const auth = await requirePageSession('/onboarding');
  const record = await getAppSettings();
  const gate = onboardingGate(auth, record.settings);
  const t = await getT(onboarding);

  // A viewer is offered no step: rather than a 403 on a screen that was not meant
  // for them, we tell them how things stand and where to go.
  if (!gate.applies) {
    return (
      <>
        <OnboardingTopbar
          instanceName={record.settings.instanceName}
          eyebrow={t('shell.eyebrow')}
        />
        <main className="mx-auto flex w-full max-w-[1040px] flex-col gap-6 px-6 py-9">
          <PageHeader
            title={t('notApplicable.title')}
            description={t('notApplicable.description')}
          />
          <EmptyState
            title={t('notApplicable.empty.title')}
            hint={t('notApplicable.empty.hint')}
            action={
              <Button asChild variant="secondary">
                <Link href="/">{t('notApplicable.back')}</Link>
              </Button>
            }
          />
        </main>
      </>
    );
  }

  const environment = await onboardingEnvironment(auth);
  // The assignable roles come from the database, as on /admin/users: a role
  // created at the previous step must be offered at the next one.
  const roleKeys = auth.can('role:read')
    ? (await listRoles()).map((role) => role.key)
    : (['viewer'] as RoleKey[]);

  /**
   * The same list as in the Regional settings section, and for the same reason:
   * the selector only offers the languages the panel really speaks, but it never
   * hides the value in place. An instance left on `de-DE` would otherwise see a
   * list without what it shows, and the first save would change its locale
   * without anybody asking for it.
   */
  const offered: SupportedLocale[] = [...TRANSLATED_LOCALES];
  const locales = offered.includes(record.settings.locale)
    ? offered
    : [record.settings.locale, ...offered];

  return (
    <OnboardingWizard
      instanceName={record.settings.instanceName}
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
      proxyTargets={
        auth.can('target:update')
          ? (await listTargets()).map((target) => ({ id: target.id, name: target.name }))
          : []
      }
      format={formatSettingsOf(record.settings)}
      userEmail={auth.email}
      canInvite={await canSendAccountMail()}
    />
  );
}
