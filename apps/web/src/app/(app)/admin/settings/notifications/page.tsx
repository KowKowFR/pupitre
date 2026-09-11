import { presentNotificationChannels, presentNotificationEvents } from '@tp/core';
import { listNotificationChannels } from '@tp/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requirePagePermission } from '@/lib/page-auth';
import { settingsSection } from '../sections';
import { NotificationsManager } from './notifications-manager';

export const dynamic = 'force-dynamic';

const section = settingsSection('/admin/settings/notifications');

/**
 * Les canaux ne vivent pas dans le JSONB des paramètres mais dans leur propre
 * table : il y en a plusieurs, ils portent des secrets, et ils portent un état
 * d'exécution qui change tout seul. Le raisonnement complet est en tête de
 * `packages/db/src/schema/notifications.ts`.
 *
 * Le catalogue est lu ici, côté serveur, et passé tel quel : l'écran ne connaît
 * le nom d'aucun canal ni d'aucun champ — il rend ce que le catalogue décrit.
 */
export default async function NotificationSettingsPage() {
  const auth = await requirePagePermission('/admin/settings/notifications', 'settings:read');
  const channels = await listNotificationChannels();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{section.title}</CardTitle>
        <CardDescription>{section.governs}</CardDescription>
      </CardHeader>
      <CardContent>
        <NotificationsManager
          initialChannels={channels.map((channel) => ({
            ...channel,
            lastSuccessAt: channel.lastSuccessAt?.toISOString() ?? null,
            lastFailureAt: channel.lastFailureAt?.toISOString() ?? null,
          }))}
          catalog={presentNotificationChannels()}
          events={presentNotificationEvents()}
          canManage={auth.can('settings:manage')}
        />
      </CardContent>
    </Card>
  );
}
