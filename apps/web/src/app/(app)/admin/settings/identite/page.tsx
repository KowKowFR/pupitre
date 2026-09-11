import { getAppSettings } from '@tp/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requirePagePermission } from '@/lib/page-auth';
import { settingsSection } from '../sections';
import { IdentityForm } from './identity-form';

export const dynamic = 'force-dynamic';

const section = settingsSection('/admin/settings/identite');

export default async function IdentitySettingsPage() {
  const auth = await requirePagePermission('/admin/settings/identite', 'settings:read');
  const { settings } = await getAppSettings();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{section.title}</CardTitle>
        <CardDescription>{section.governs}</CardDescription>
      </CardHeader>
      <CardContent>
        <IdentityForm settings={settings} canManage={auth.can('settings:manage')} />
      </CardContent>
    </Card>
  );
}
