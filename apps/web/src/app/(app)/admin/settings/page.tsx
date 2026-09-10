import { DATE_STYLES, SUPPORTED_LOCALES, supportedTimeZones } from '@tp/core';
import { getAppSettings } from '@tp/db';
import { PageHeader } from '@/components/page-header';
import { requirePagePermission } from '@/lib/page-auth';
import { OnboardingRestart } from './onboarding-restart';
import { SettingsEditor } from './settings-editor';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const auth = await requirePagePermission('/admin/settings', 'settings:read');

  // Lecture directe via `@tp/db`, pas de `fetch` sur notre propre API : la page
  // est déjà sur le serveur, un aller-retour HTTP interne n'ajouterait qu'une
  // latence et un cookie à réémettre.
  const record = await getAppSettings();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Administration"
        title="Paramètres"
        description={
          <>
            Réglages de l&apos;instance, appliqués à chaud. Ils vivent dans une ligne unique de{' '}
            <code className="font-mono text-xs">app_settings</code> — un seul JSONB, pour
            qu&apos;ajouter un réglage ne coûte pas une migration. La clé d&apos;API, elle, est
            chiffrée dans sa propre colonne et ne ressort jamais d&apos;ici.
          </>
        }
        actions={
          <span className="font-mono text-xs text-ink-faint">
            {record.updatedAt ? 'personnalisés' : 'valeurs par défaut'}
          </span>
        }
      />

      <SettingsEditor
        settings={record.settings}
        aiApiKeyConfigured={record.aiApiKeyConfigured}
        aiApiKeyLast4={record.aiApiKeyLast4}
        timezones={supportedTimeZones()}
        locales={[...SUPPORTED_LOCALES]}
        dateStyles={[...DATE_STYLES]}
        canManage={auth.can('settings:manage')}
      />

      {/* Dernier bloc, à dessein : c'est un raccourci vers un parcours, pas un
          réglage de plus — il n'a rien à faire au milieu des champs. */}
      <OnboardingRestart
        state={record.settings.onboarding}
        canManage={auth.can('settings:manage')}
      />
    </div>
  );
}
