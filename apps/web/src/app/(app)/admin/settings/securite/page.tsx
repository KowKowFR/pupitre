import { getAppSettings } from '@pupitre/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getT } from '@/i18n/server';
import { settings as messages } from '@/i18n/messages/settings';
import { requirePagePermission } from '@/lib/page-auth';
import { settingsSection } from '../sections';
import { SecurityForm } from './security-form';

export const dynamic = 'force-dynamic';

const section = settingsSection('/admin/settings/securite');

export default async function SecuritySettingsPage() {
  const auth = await requirePagePermission('/admin/settings/securite', 'settings:read');
  const { settings } = await getAppSettings();
  const t = await getT(messages);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t(`section.${section.id}.title`)}
          <Badge variant={settings.security.scanningEnabled ? 'ok' : 'destructive'}>
            {settings.security.scanningEnabled ? t('security.badge.on') : t('security.badge.off')}
          </Badge>
        </CardTitle>
        <CardDescription>{t(`section.${section.id}.governs`)}</CardDescription>
      </CardHeader>
      <CardContent>
        <SecurityForm settings={settings} canManage={auth.can('settings:manage')} />
      </CardContent>
    </Card>
  );
}
