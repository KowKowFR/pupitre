import { DATE_STYLES, SUPPORTED_LOCALES, supportedTimeZones } from '@pupitre/core';
import { getAppSettings } from '@pupitre/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requirePagePermission } from '@/lib/page-auth';
import { settingsSection } from '../sections';
import { RegionalForm } from './regional-form';

export const dynamic = 'force-dynamic';

const section = settingsSection('/admin/settings/regionalisation');

export default async function RegionalSettingsPage() {
  const auth = await requirePagePermission('/admin/settings/regionalisation', 'settings:read');
  const { settings } = await getAppSettings();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{section.title}</CardTitle>
        <CardDescription>{section.governs}</CardDescription>
      </CardHeader>
      <CardContent>
        <RegionalForm
          settings={settings}
          timezones={supportedTimeZones()}
          locales={[...SUPPORTED_LOCALES]}
          dateStyles={[...DATE_STYLES]}
          canManage={auth.can('settings:manage')}
        />
      </CardContent>
    </Card>
  );
}
