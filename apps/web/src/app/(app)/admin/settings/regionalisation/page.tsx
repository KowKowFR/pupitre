import { DATE_STYLES, TRANSLATED_LOCALES, supportedTimeZones, type SupportedLocale } from '@pupitre/core';
import { getAppSettings } from '@pupitre/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getT } from '@/i18n/server';
import { settings as messages } from '@/i18n/messages/settings';
import { requirePagePermission } from '@/lib/page-auth';
import { RegionalForm } from './regional-form';

export const dynamic = 'force-dynamic';

export default async function RegionalSettingsPage() {
  const auth = await requirePagePermission('/admin/settings/regionalisation', 'settings:read');
  const { settings } = await getAppSettings();
  const t = await getT(messages);

  /**
   * On n'offre que les langues réellement écrites — mais jamais au prix de
   * cacher la valeur en place. Une instance restée sur `de-DE` verrait sinon
   * une liste qui ne contient pas ce qu'elle affiche, et le premier
   * enregistrement changerait sa locale sans que personne l'ait demandé.
   */
  const offered: SupportedLocale[] = [...TRANSLATED_LOCALES];
  const locales = offered.includes(settings.locale) ? offered : [settings.locale, ...offered];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('section.regional.title')}</CardTitle>
        <CardDescription>{t('section.regional.governs')}</CardDescription>
      </CardHeader>
      <CardContent>
        <RegionalForm
          settings={settings}
          timezones={supportedTimeZones()}
          locales={locales}
          dateStyles={[...DATE_STYLES]}
          canManage={auth.can('settings:manage')}
        />
      </CardContent>
    </Card>
  );
}
