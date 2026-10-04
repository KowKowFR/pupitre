import {
  SENSITIVE_PERMISSIONS,
  TWO_FACTOR_POLICIES,
  requiresTwoFactor,
  type TwoFactorPolicy,
} from '@pupitre/core';
import { getAppSettings, listRolesWithPermissions, listTwoFactorExposure } from '@pupitre/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { HelpTip } from '@/components/ui/help-tip';
import { getT } from '@/i18n/server';
import { settings as messages } from '@/i18n/messages/settings';
import { requirePagePermission } from '@/lib/page-auth';
import { settingsSection } from '../sections';
import { AccountsForm, type PolicyReach } from './accounts-form';

export const dynamic = 'force-dynamic';

const section = settingsSection('/admin/settings/accounts');

/**
 * Accounts and sessions: the required second factor, the sessions' duration.
 *
 * Before saving a policy, one wants to know whom it would keep out: each policy
 * is therefore evaluated here, on the real roles and accounts, and the screen
 * only has to show the chosen one.
 */
export default async function AccountsSettingsPage() {
  const auth = await requirePagePermission('/admin/settings/accounts', 'settings:read');
  const [{ settings }, roles, exposure, t] = await Promise.all([
    getAppSettings(),
    listRolesWithPermissions(),
    listTwoFactorExposure(),
    getT(messages),
  ]);
  const policy = settings.accounts.twoFactorPolicy;
  const self = exposure.find((entry) => entry.userId === auth.userId);

  const reach = Object.fromEntries(
    TWO_FACTOR_POLICIES.map((candidate): [TwoFactorPolicy, PolicyReach] => [
      candidate,
      {
        roles: roles
          .filter((role) => requiresTwoFactor(role.permissions, candidate))
          .map((role) => role.label),
        // An account without a password only comes in through single sign-on: the
        // second factor is the provider's business there (`rbac.ts`).
        missing: exposure.filter(
          (entry) =>
            entry.hasPassword &&
            !entry.twoFactorEnabled &&
            requiresTwoFactor(entry.permissions, candidate),
        ).length,
        self:
          self !== undefined &&
          self.hasPassword &&
          !self.twoFactorEnabled &&
          requiresTwoFactor(auth.permissions, candidate),
      },
    ]),
  ) as Record<TwoFactorPolicy, PolicyReach>;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t(`section.${section.id}.title`)}
          <Badge variant={policy === 'off' ? 'idle' : 'ok'} dot>
            {t(`accounts.state.${policy}`)}
          </Badge>
          <HelpTip>{t(`section.${section.id}.governs`)}</HelpTip>
        </CardTitle>
        <CardDescription className="first-letter:uppercase">
          {t(`section.${section.id}.short`)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AccountsForm
          settings={settings.accounts}
          reach={reach}
          sensitive={[...SENSITIVE_PERMISSIONS]}
          canManage={auth.can('settings:manage')}
        />
      </CardContent>
    </Card>
  );
}
