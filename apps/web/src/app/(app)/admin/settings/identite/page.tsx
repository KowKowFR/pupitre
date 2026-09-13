import { getAppSettings } from '@pupitre/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getT } from '@/i18n/server';
import { settings as messages } from '@/i18n/messages/settings';
import { requirePagePermission } from '@/lib/page-auth';
import { settingsSection } from '../sections';
import { IdentityForm } from './identity-form';

export const dynamic = 'force-dynamic';

const section = settingsSection('/admin/settings/identite');

export default async function IdentitySettingsPage() {
  const auth = await requirePagePermission('/admin/settings/identite', 'settings:read');
  const { settings } = await getAppSettings();
  const t = await getT(messages);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(`section.${section.id}.title`)}</CardTitle>
        <CardDescription>{t(`section.${section.id}.governs`)}</CardDescription>
      </CardHeader>
      <CardContent>
        <IdentityForm settings={settings} canManage={auth.can('settings:manage')} />
      </CardContent>
    </Card>
  );
}
