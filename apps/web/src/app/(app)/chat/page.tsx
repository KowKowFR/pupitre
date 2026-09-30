import { CHAT_DEFAULT_CHANNEL, CHAT_PAGE_SIZE } from '@pupitre/core';
import {
  getAppSettings,
  getChatReadMarker,
  listApplications,
  listChatMembers,
  listChatMessages,
  listTargets,
} from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { getT } from '@/i18n/server';
import { chat as messages } from '@/i18n/messages/chat';
import type { DirectoryEntry } from '@/lib/chat';
import { formatSettingsOf } from '@/lib/format';
import { requirePageSession } from '@/lib/page-auth';
import { ChatView } from './chat-view';

export const dynamic = 'force-dynamic';

/**
 * La discussion de l'équipe. La page rend les derniers messages et l'annuaire
 * des mentions ; le reste arrive par le flux temps réel.
 *
 * L'annuaire suit les permissions de la session : une machine ne s'y trouve
 * que pour qui peut ouvrir les cibles, une application que pour qui peut
 * ouvrir les applications. Les personnes, elles, s'y trouvent toutes.
 */
export default async function ChatPage() {
  const auth = await requirePageSession('/chat');
  const t = await getT(messages);
  const { settings } = await getAppSettings();

  const [history, members, marker, targets, applications] = await Promise.all([
    listChatMessages(CHAT_DEFAULT_CHANNEL, { limit: CHAT_PAGE_SIZE }),
    listChatMembers(),
    getChatReadMarker(auth.userId, CHAT_DEFAULT_CHANNEL),
    auth.can('target:read') ? listTargets() : Promise.resolve([]),
    auth.can('application:read') ? listApplications() : Promise.resolve([]),
  ]);

  const directory: DirectoryEntry[] = [
    ...members.map((member) => ({
      kind: 'user' as const,
      id: member.id,
      label: member.name,
      hint: member.email,
    })),
    ...targets.map((target) => ({
      kind: 'target' as const,
      id: target.id,
      label: target.name,
      hint: target.host,
    })),
    ...applications.map((application) => ({
      kind: 'app' as const,
      id: application.id,
      label: application.slug,
      hint: application.description,
    })),
  ];

  return (
    <>
      <PageHeader title={t('page.title')} description={t('page.description')} />
      <ChatView
        initial={history}
        hasMore={history.length === CHAT_PAGE_SIZE}
        readMarker={marker?.toISOString() ?? null}
        directory={directory}
        canModerate={auth.can('user:manage')}
        format={formatSettingsOf(settings)}
        now={new Date().toISOString()}
      />
    </>
  );
}
