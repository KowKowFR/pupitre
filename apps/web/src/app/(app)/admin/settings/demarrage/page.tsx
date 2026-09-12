import { getAppSettings } from '@pupitre/db';
import { requirePagePermission } from '@/lib/page-auth';
import { OnboardingRestart } from './onboarding-restart';

export const dynamic = 'force-dynamic';

/**
 * L'assistant n'est pas un réglage : c'est un raccourci vers un parcours. Il a
 * sa propre adresse pour la même raison qu'il avait son propre bloc en bas de
 * l'ancienne page — on ne vient pas ici pour cocher une case, on vient
 * recommencer la prise en main.
 */
export default async function OnboardingSettingsPage() {
  const auth = await requirePagePermission('/admin/settings/demarrage', 'settings:read');
  const { settings } = await getAppSettings();

  return (
    <OnboardingRestart state={settings.onboarding} canManage={auth.can('settings:manage')} />
  );
}
