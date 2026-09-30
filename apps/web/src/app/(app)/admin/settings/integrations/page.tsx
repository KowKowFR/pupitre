import { listGitHubInstallations, type GitHubInstallation } from '@pupitre/core/sources';
import { countApplicationSources, getAppSettingsValue, getSourceConnection } from '@pupitre/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getT } from '@/i18n/server';
import { settings as messages } from '@/i18n/messages/settings';
import { requirePagePermission } from '@/lib/page-auth';
import { connectionView, credentialsOf } from '@/lib/sources';
import { settingsSection } from '../sections';
import { GitHubIntegration } from './github-integration';

export const dynamic = 'force-dynamic';

const section = settingsSection('/admin/settings/integrations');

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Paramètres → Intégrations : la GitHub App de l'instance.
 *
 * Les installations sont lues chez GitHub à chaque affichage (un appel
 * sortant) : c'est la seule source qui dise où l'App a été installée depuis
 * la dernière visite. Une panne de GitHub ne casse pas la page — elle le dit.
 */
export default async function IntegrationsSettingsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const auth = await requirePagePermission('/admin/settings/integrations', 'settings:read');
  const t = await getT(messages);
  const params = await searchParams;
  const [connection, sourcesCount, settings] = await Promise.all([
    getSourceConnection('github'),
    countApplicationSources(),
    getAppSettingsValue(),
  ]);

  let installations: GitHubInstallation[] = [];
  let installationsError: string | null = null;
  if (connection) {
    try {
      installations = await listGitHubInstallations(credentialsOf(connection));
    } catch (error) {
      installationsError = error instanceof Error ? error.message : String(error);
    }
  }

  const flag = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(`section.${section.id}.title`)}</CardTitle>
        <CardDescription>{t(`section.${section.id}.governs`)}</CardDescription>
      </CardHeader>
      <CardContent>
        <GitHubIntegration
          connection={connection ? connectionView(connection) : null}
          installations={installations}
          installationsError={installationsError}
          sourcesCount={sourcesCount}
          instanceName={settings.instanceName}
          canManage={auth.can('settings:manage')}
          notice={
            flag('error') === 'state'
              ? 'state'
              : flag('error') === 'github'
                ? 'github'
                : flag('setup_action') === 'install' || flag('installation_id')
                  ? 'installed'
                  : null
          }
        />
      </CardContent>
    </Card>
  );
}
