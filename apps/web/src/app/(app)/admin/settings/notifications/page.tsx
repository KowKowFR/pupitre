import {
  NOTIFICATION_DIGEST_ITEM_LIMIT,
  NOTIFICATION_DIGEST_MAX_ESCALATION,
  NOTIFICATION_DIGEST_WINDOW_MS_MAX,
  NOTIFICATION_DIGEST_WINDOW_MS_MIN,
  notificationDigestWindowMs,
  presentNotificationChannels,
  presentNotificationEvents,
} from '@pupitre/core';
import {
  getAppSettingsValue,
  getNotificationDigestPolicy,
  listNotificationChannels,
  listNotificationDigestStates,
} from '@pupitre/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { currentLanguage, getT } from '@/i18n/server';
import { notifications as notificationMessages } from '@/i18n/messages/notifications';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { DigestPolicy } from './digest-policy';
import { NotificationsManager } from './notifications-manager';

export const dynamic = 'force-dynamic';

/**
 * The channels do not live in the settings' JSONB but in their own table: there
 * are several of them, they carry secrets, and they carry a run state that
 * changes on its own. The complete reasoning is at the top of
 * `packages/db/src/schema/notifications.ts`.
 *
 * The catalog is read here, on the server side, and passed as is: the screen
 * knows the name of no channel nor of any field — it renders what the catalog
 * describes.
 */
export default async function NotificationSettingsPage() {
  const auth = await requirePagePermission('/admin/settings/notifications', 'settings:read');
  const [channels, policy, states, settings] = await Promise.all([
    listNotificationChannels(),
    getNotificationDigestPolicy(),
    listNotificationDigestStates(),
    getAppSettingsValue(),
  ]);
  // Both catalogs carry their own prose — the events as well as the channels and
  // their fields' labels: they are given the instance's language rather than left
  // to fall back on their French default.
  const language = await currentLanguage();
  const events = presentNotificationEvents(language);
  const t = await getT(notificationMessages);

  return (
    <div className="flex flex-col gap-4">
      <NotificationsManager
        title={t('channels.title')}
        description={t('channels.description')}
        initialChannels={channels.map((channel) => ({
          ...channel,
          lastSuccessAt: channel.lastSuccessAt?.toISOString() ?? null,
          lastFailureAt: channel.lastFailureAt?.toISOString() ?? null,
        }))}
        catalog={presentNotificationChannels(language)}
        events={events}
        canManage={auth.can('settings:manage')}
        format={formatSettingsOf(settings)}
      />

      {/*
        Grouping is a card of its own, and not one more field in a channel's
        form: it is not set per channel. Fifty outages must fit in one message,
        whether the on-call reads their alerts by email or in a chat room.
             */}
      <Card>
        <CardHeader>
          <CardTitle>{t('digest.card.title')}</CardTitle>
          <CardDescription>{t('digest.card.description')}</CardDescription>
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
            format={formatSettingsOf(settings)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
