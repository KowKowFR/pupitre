import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAppSettingsValue } from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { account as messages } from '@/i18n/messages/account';
import { getT } from '@/i18n/server';
import { requirePageSession } from '@/lib/page-auth';
import { TwoFactorPanel } from '../../(app)/account/two-factor-panel';
import { OnboardingTopbar } from '../../(onboarding)/onboarding-topbar';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('enroll.meta.title') };
}

export const dynamic = 'force-dynamic';

/**
 * The only screen of an account the instance's policy binds to the second factor,
 * as long as it does not have it: the "My account" panel, alone. Once armed, the
 * refresh that follows the activation sends back to the panel.
 */
export default async function TwoFactorSetupPage() {
  const auth = await requirePageSession('/two-factor-setup');
  if (!auth.twoFactor.mustEnroll) redirect('/');
  const [settings, t] = await Promise.all([getAppSettingsValue(), getT(messages)]);

  return (
    <>
      <OnboardingTopbar instanceName={settings.instanceName} eyebrow={t('enroll.eyebrow')}>
        <Button asChild variant="ghost" size="sm">
          <Link href="/logout">{t('enroll.logout')}</Link>
        </Button>
      </OnboardingTopbar>
      <main className="mx-auto flex w-full max-w-[640px] flex-col gap-6 px-4 py-9 sm:px-6">
        <PageHeader title={t('enroll.title')} description={t('enroll.description')} />
        <TwoFactorPanel enabled={false} required />
      </main>
    </>
  );
}
