import { ssoCallbackUrl } from '@pupitre/core';
import { getAppSettings, listRoles } from '@pupitre/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { HelpTip } from '@/components/ui/help-tip';
import { settings as messages } from '@/i18n/messages/settings';
import { getT } from '@/i18n/server';
import { getEnv } from '@/lib/env';
import { requirePagePermission } from '@/lib/page-auth';
import { currentSso } from '@/lib/sso';
import { describeSsoProblem } from '@/lib/sso-problem';
import { settingsSection } from '../sections';
import { SsoForm } from './sso-form';

export const dynamic = 'force-dynamic';

const section = settingsSection('/admin/settings/connexion');

export default async function SsoSettingsPage() {
  const auth = await requirePagePermission('/admin/settings/connexion', 'settings:read');
  const [record, roles, state, t] = await Promise.all([
    getAppSettings(),
    listRoles(),
    currentSso(),
    getT(messages),
  ]);
  const sso = record.settings.sso;
  const badge = !sso.enabled
    ? { variant: 'idle' as const, label: t('sso.badge.off') }
    : state.runtime
      ? { variant: 'ok' as const, label: t('sso.badge.active') }
      : { variant: 'warn' as const, label: t('sso.badge.error') };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t(`section.${section.id}.title`)}
          <Badge variant={badge.variant} dot>
            {badge.label}
          </Badge>
          <HelpTip>{t(`section.${section.id}.governs`)}</HelpTip>
        </CardTitle>
        <CardDescription className="first-letter:uppercase">
          {t(`section.${section.id}.short`)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SsoForm
          settings={sso}
          secretConfigured={record.ssoClientSecretConfigured}
          status={{
            active: state.runtime !== null,
            error: sso.enabled && state.problem ? describeSsoProblem(state.problem, t) : null,
          }}
          callbackUrl={ssoCallbackUrl(getEnv().BETTER_AUTH_URL)}
          roles={roles.map((role) => ({ key: role.key, label: role.label }))}
          canManage={auth.can('settings:manage')}
        />
      </CardContent>
    </Card>
  );
}
