import {
  NOTIFICATION_DIGEST_ITEM_LIMIT,
  NOTIFICATION_DIGEST_MAX_ESCALATION,
  NOTIFICATION_DIGEST_WINDOW_MS_MAX,
  NOTIFICATION_DIGEST_WINDOW_MS_MIN,
  notificationDigestWindowMs,
  presentNotificationChannels,
  presentNotificationEvents,
} from '@tp/core';
import {
  getNotificationDigestPolicy,
  listNotificationChannels,
  listNotificationDigestStates,
} from '@tp/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requirePagePermission } from '@/lib/page-auth';
import { settingsSection } from '../sections';
import { DigestPolicy } from './digest-policy';
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
  const [channels, policy, states] = await Promise.all([
    listNotificationChannels(),
    getNotificationDigestPolicy(),
    listNotificationDigestStates(),
  ]);
  const events = presentNotificationEvents();

  return (
    <div className="flex flex-col gap-4">
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
            events={events}
            canManage={auth.can('settings:manage')}
          />
        </CardContent>
      </Card>

      {/*
        Le regroupement est une carte à part, et non un champ de plus dans le
        formulaire d'un canal : il ne se règle pas par canal. Cinquante pannes
        doivent tenir en un message, que l'astreinte lise ses alertes par e-mail
        ou dans un salon.
      */}
      <Card>
        <CardHeader>
          <CardTitle>Regroupement des alertes</CardTitle>
          <CardDescription>
            Ce qui empêche cinquante pannes en dix minutes de produire cinquante messages — sans
            jamais retarder la première.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DigestPolicy
            initialWindowMs={policy.windowMs}
            initialStates={states
              .filter((state) => state.windowEndsAt !== null)
              .map((state) => ({
                ...state,
                windowEndsAt: state.windowEndsAt?.toISOString() ?? null,
                firstHeldAt: state.firstHeldAt?.toISOString() ?? null,
                lastHeldAt: state.lastHeldAt?.toISOString() ?? null,
              }))}
            vocabulary={{
              minWindowMs: NOTIFICATION_DIGEST_WINDOW_MS_MIN,
              maxWindowMs: NOTIFICATION_DIGEST_WINDOW_MS_MAX,
              maxEscalation: NOTIFICATION_DIGEST_MAX_ESCALATION,
              widestWindowMs: notificationDigestWindowMs(
                policy.windowMs,
                NOTIFICATION_DIGEST_MAX_ESCALATION,
              ),
              itemLimit: NOTIFICATION_DIGEST_ITEM_LIMIT,
            }}
            events={events}
            canManage={auth.can('settings:manage')}
          />
        </CardContent>
      </Card>
    </div>
  );
}
