import { getAiApiKey, getAppSettings } from '@pupitre/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { HelpTip } from '@/components/ui/help-tip';
import { getT } from '@/i18n/server';
import { settings as messages } from '@/i18n/messages/settings';
import { requirePagePermission } from '@/lib/page-auth';
import { AiStatusBadge } from '../ai-status';
import { settingsSection } from '../sections';
import { AiForm } from './ai-form';

export const dynamic = 'force-dynamic';

const section = settingsSection('/admin/settings/ia');

/**
 * La seule page qui affiche la section IA.
 *
 * Ce qui descend au client : le fait qu'une clé soit posée, et ses quatre
 * derniers caractères. Jamais la clé — `getAppSettings()` ne la rend
 * physiquement pas.
 */
export default async function AiSettingsPage() {
  const auth = await requirePagePermission('/admin/settings/ia', 'settings:read');
  const record = await getAppSettings();
  const t = await getT(messages);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t(`section.${section.id}.title`)}
          <AiStatusBadge settings={record.settings} storedApiKey={await getAiApiKey()} />
          <HelpTip>
            {t(`section.${section.id}.governs`)} {t('ai.noShell')}
          </HelpTip>
        </CardTitle>
        <CardDescription className="first-letter:uppercase">
          {t(`section.${section.id}.short`)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AiForm
          settings={record.settings}
          aiApiKeyConfigured={record.aiApiKeyConfigured}
          aiApiKeyLast4={record.aiApiKeyLast4}
          canManage={auth.can('settings:manage')}
        />
      </CardContent>
    </Card>
  );
}
