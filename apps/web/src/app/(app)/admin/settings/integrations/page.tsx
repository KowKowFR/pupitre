import { listGitHubInstallations, type GitHubInstallation } from '@pupitre/core/sources';
import { countApplicationSources, getAppSettingsValue, getSourceConnection } from '@pupitre/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { HelpTip } from '@/components/ui/help-tip';
import { getT } from '@/i18n/server';
import { settings as messages } from '@/i18n/messages/settings';
import { requirePagePermission } from '@/lib/page-auth';
import { githubConnectionView, githubCredentialsOf, tokenForgeConnectionView } from '@/lib/sources';
import { settingsSection } from '../sections';
import { GitHubIntegration } from './github-integration';
import { TokenForgeIntegration } from './token-forge-integration';

export const dynamic = 'force-dynamic';

const section = settingsSection('/admin/settings/integrations');

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Settings → Integrations: the instance's code providers — the GitHub App, a
 * GitLab instance and a Gitea / Forgejo forge.
 *
 * The installations are read at GitHub at each display (an outgoing call): it is
 * the only source that says where the App was installed since the last visit. A
 * GitHub outage does not break the page — it says so.
 */
export default async function IntegrationsSettingsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const auth = await requirePagePermission('/admin/settings/integrations', 'settings:read');
  const t = await getT(messages);
  const params = await searchParams;
  const [connection, gitlab, gitea, settings] = await Promise.all([
    getSourceConnection('github'),
    getSourceConnection('gitlab'),
    getSourceConnection('gitea'),
    getAppSettingsValue(),
  ]);
  const [sourcesCount, gitlabSourcesCount, giteaSourcesCount] = await Promise.all([
    connection ? countApplicationSources(connection.id) : Promise.resolve(0),
    gitlab ? countApplicationSources(gitlab.id) : Promise.resolve(0),
    gitea ? countApplicationSources(gitea.id) : Promise.resolve(0),
  ]);

  let installations: GitHubInstallation[] = [];
  let installationsError: string | null = null;
  if (connection) {
    try {
      installations = await listGitHubInstallations(githubCredentialsOf(connection));
    } catch (error) {
      installationsError = error instanceof Error ? error.message : String(error);
    }
  }

  const flag = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t(`section.${section.id}.title`)}
          <HelpTip>{t(`section.${section.id}.governs`)}</HelpTip>
        </CardTitle>
        <CardDescription className="first-letter:uppercase">
          {t(`section.${section.id}.short`)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-8">
        <GitHubIntegration
          connection={connection ? githubConnectionView(connection) : null}
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
        <div className="border-t border-border-subtle pt-8">
          <TokenForgeIntegration
            kind="gitlab"
            connection={gitlab ? tokenForgeConnectionView(gitlab) : null}
            sourcesCount={gitlabSourcesCount}
            canManage={auth.can('settings:manage')}
          />
        </div>
        <div className="border-t border-border-subtle pt-8">
          <TokenForgeIntegration
            kind="gitea"
            connection={gitea ? tokenForgeConnectionView(gitea) : null}
            sourcesCount={giteaSourcesCount}
            canManage={auth.can('settings:manage')}
          />
        </div>
      </CardContent>
    </Card>
  );
}
