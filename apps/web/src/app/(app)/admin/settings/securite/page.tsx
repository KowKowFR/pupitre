import { getAppSettings } from '@tp/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requirePagePermission } from '@/lib/page-auth';
import { settingsSection } from '../sections';
import { SecurityForm } from './security-form';

export const dynamic = 'force-dynamic';

const section = settingsSection('/admin/settings/securite');

export default async function SecuritySettingsPage() {
  const auth = await requirePagePermission('/admin/settings/securite', 'settings:read');
  const { settings } = await getAppSettings();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {section.title}
          <Badge variant={settings.security.scanningEnabled ? 'ok' : 'destructive'}>
            {settings.security.scanningEnabled ? 'active' : 'désactivée'}
          </Badge>
        </CardTitle>
        <CardDescription>{section.governs}</CardDescription>
      </CardHeader>
      <CardContent>
        <SecurityForm settings={settings} canManage={auth.can('settings:manage')} />
      </CardContent>
    </Card>
  );
}
