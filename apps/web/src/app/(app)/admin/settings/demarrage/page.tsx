import { getAppSettings } from '@pupitre/db';
import { requirePagePermission } from '@/lib/page-auth';
import { OnboardingRestart } from './onboarding-restart';

export const dynamic = 'force-dynamic';

/**
 * The assistant is not a setting: it is a shortcut to a journey. It has its own
 * address for the same reason it had its own block at the bottom of the old
 * page — one does not come here to tick a box, one comes to start the getting
 * started over.
 */
export default async function OnboardingSettingsPage() {
  const auth = await requirePagePermission('/admin/settings/demarrage', 'settings:read');
  const { settings } = await getAppSettings();

  return (
    <OnboardingRestart state={settings.onboarding} canManage={auth.can('settings:manage')} />
  );
}
