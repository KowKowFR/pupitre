import type { ReactNode } from 'react';
import { getAppSettings } from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { FieldHelpMode } from '@/components/ui/field';
import { HelpTip } from '@/components/ui/help-tip';
import { getT } from '@/i18n/server';
import { settings as messages } from '@/i18n/messages/settings';
import { requirePagePermission } from '@/lib/page-auth';
import { SettingsNav, SettingsTabs } from './settings-nav';

export const dynamic = 'force-dynamic';

/**
 * Coquille des paramètres.
 *
 * Quatre groupes au rail, les sections d'un groupe en onglets. Chaque section
 * reste une page : une adresse, rendue sur le serveur, partageable dans un
 * ticket, et dont le code client ne charge que ce qu'elle affiche.
 *
 * L'écran est dense : les aides des champs s'y replient en info-bulles
 * (`FieldHelpMode`), et la présentation de la page aussi.
 *
 * Le layout porte ce qui est commun à toutes les sections : le bandeau de
 * page, le rail, et la mention de lecture seule. La poser ici plutôt que dans
 * chaque formulaire évite de la répéter cinq fois et garantit qu'aucune
 * section ne l'oublie.
 *
 * La permission est vérifiée ici **et** dans chaque page. Ce n'est pas de la
 * redondance décorative : un layout n'est pas réexécuté quand on navigue entre
 * deux de ses enfants côté client, seule la page l'est.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const auth = await requirePagePermission('/admin/settings', 'settings:read');
  const record = await getAppSettings();
  const t = await getT(messages);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('page.title')}
        description={
          <>
            {t('page.description.short')}
            <HelpTip>
              {t('page.description.before')} <code className="mono">app_settings</code>{' '}
              {t('page.description.after')}
            </HelpTip>
          </>
        }
        actions={
          <Badge variant="outline">
            {record.updatedAt ? t('page.state.customized') : t('page.state.defaults')}
          </Badge>
        }
      />

      <div className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-[216px_minmax(0,1fr)]">
        <SettingsNav />
        <div className="flex min-w-0 flex-col gap-4">
          <SettingsTabs />
          {auth.can('settings:manage') ? null : (
            <Alert>
              {t('page.readonly.before')} <code className="mono">settings:manage</code>{' '}
              {t('page.readonly.after')}
            </Alert>
          )}
          <FieldHelpMode mode="tip">{children}</FieldHelpMode>
        </div>
      </div>
    </div>
  );
}
