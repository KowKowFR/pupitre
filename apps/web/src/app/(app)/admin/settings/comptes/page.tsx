import {
  SENSITIVE_PERMISSIONS,
  TWO_FACTOR_POLICIES,
  requiresTwoFactor,
  type TwoFactorPolicy,
} from '@pupitre/core';
import { getAppSettings, listRolesWithPermissions, listTwoFactorExposure } from '@pupitre/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getT } from '@/i18n/server';
import { settings as messages } from '@/i18n/messages/settings';
import { requirePagePermission } from '@/lib/page-auth';
import { settingsSection } from '../sections';
import { AccountsForm, type PolicyReach } from './accounts-form';

export const dynamic = 'force-dynamic';

const section = settingsSection('/admin/settings/comptes');

/**
 * Comptes et sessions : le second facteur exigé, la durée des sessions.
 *
 * Avant d'enregistrer une politique, on veut savoir qui elle tiendrait à
 * l'écart : chaque politique est donc évaluée ici, sur les rôles et les comptes
 * réels, et l'écran n'a plus qu'à montrer celle qui est choisie.
 */
export default async function AccountsSettingsPage() {
  const auth = await requirePagePermission('/admin/settings/comptes', 'settings:read');
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
        // Un compte sans mot de passe n'entre que par la connexion unique : le
        // second facteur y est l'affaire du fournisseur (`rbac.ts`).
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
        </CardTitle>
        <CardDescription>{t(`section.${section.id}.governs`)}</CardDescription>
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
