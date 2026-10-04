import { DATE_STYLES, TRANSLATED_LOCALES, supportedTimeZones, type SupportedLocale } from '@pupitre/core';
import { getAppSettings } from '@pupitre/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { HelpTip } from '@/components/ui/help-tip';
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
   * Only the languages really written are offered — but never at the price of
   * hiding the value in place. An instance left on `de-DE` would otherwise see a
   * list that does not contain what it shows, and the first save would change its
   * locale without anybody asking for it.
   */
  const offered: SupportedLocale[] = [...TRANSLATED_LOCALES];
  const locales = offered.includes(settings.locale) ? offered : [settings.locale, ...offered];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t('section.regional.title')}
          <HelpTip>{t('section.regional.governs')}</HelpTip>
        </CardTitle>
        <CardDescription className="first-letter:uppercase">
          {t('section.regional.short')}
        </CardDescription>
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
