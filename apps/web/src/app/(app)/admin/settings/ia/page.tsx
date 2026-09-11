import { getAppSettings } from '@tp/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requirePagePermission } from '@/lib/page-auth';
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {section.title}
          <Badge variant={record.settings.ai.enabled ? 'ok' : 'secondary'}>
            {record.settings.ai.enabled ? 'activée' : 'désactivée'}
          </Badge>
        </CardTitle>
        <CardDescription>
          {section.governs} Le modèle ne produit jamais de shell : il rend du JSON, validé par Zod
          avant que quoi que ce soit ne soit exécuté.
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
