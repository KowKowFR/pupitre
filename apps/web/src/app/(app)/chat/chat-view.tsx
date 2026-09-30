'use client';

import * as React from 'react';
import { MessagesSquare, Trash2 } from 'lucide-react';
import type { ChatMessage } from '@pupitre/core';
import { EmptyState } from '@/components/empty-state';
import { PresenceAvatar, PresenceDot, sortByPresence } from '@/components/realtime/presence';
import { useRealtime } from '@/components/realtime/realtime-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { IconButton } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { chat as messages } from '@/i18n/messages/chat';
import { common } from '@/i18n/messages/common';
import type { DirectoryEntry } from '@/lib/chat';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Composer } from './composer';
import { MessageBody } from './message-body';

type Message = ChatMessage & { deleted: boolean };
type ApiError = { error?: { message?: string } };

/** Deux messages du même auteur à moins de cinq minutes se lisent comme un seul bloc. */
const GROUP_WITHIN_MS = 5 * 60_000;
/** À moins de ce nombre de pixels du bas, on suit le fil. */
const FOLLOW_THRESHOLD_PX = 80;

function dayKey(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/**
 * Le fil. Il suit le bas tant qu'on y est — un message qui arrive pendant
 * qu'on relit plus haut ne fait pas sauter la lecture. Ouvert et visible, il
 * vaut lecture : les non-lus retombent à zéro, dans tous les onglets.
 */
export function ChatView({
  initial,
  hasMore,
  readMarker,
  directory,
  canModerate,
  format,
  now,
}: {
  initial: Message[];
  hasMore: boolean;
  readMarker: string | null;
  directory: DirectoryEntry[];
  canModerate: boolean;
  format: FormatSettings;
  /** L'heure du rendu serveur : « aujourd'hui » et « hier » ne changent pas à l'hydratation. */
  now: string;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const { me, members, statusOf, subscribe, clearUnread, setReading, connected } = useRealtime();
  const [items, setItems] = React.useState<Message[]>(initial);
  const [more, setMore] = React.useState(hasMore);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<Message | null>(null);
  const [deletePending, setDeletePending] = React.useState(false);
  const [everConnected, setEverConnected] = React.useState(false);
  const scroller = React.useRef<HTMLDivElement>(null);
  const following = React.useRef(true);
  const restoreFrom = React.useRef<number | null>(null);

  // Le séparateur « Nouveaux » : posé une fois, à l'ouverture, sur le premier
  // message d'un autre arrivé après la dernière lecture.
  const [dividerId] = React.useState(
    () =>
      (readMarker &&
        initial.find((message) => message.authorId !== me && message.createdAt > readMarker)?.id) ||
      null,
  );

  // Le bandeau « connexion perdue » n'a de sens qu'après une première connexion.
  if (connected && !everConnected) setEverConnected(true);

  const markRead = React.useCallback(
    (at: string) => {
      clearUnread();
      void fetch('/api/chat/read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ at }),
      }).catch(() => undefined);
    },
    [clearUnread],
  );

  // Ouvert et visible : on lit. Caché : les messages s'accumulent en non-lus.
  React.useEffect(() => {
    const update = () => setReading(document.visibilityState === 'visible');
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      setReading(false);
    };
  }, [setReading]);

  React.useEffect(() => {
    const last = initial.at(-1);
    if (last) markRead(last.createdAt);
    else clearUnread();
    // Une seule fois, à l'ouverture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const offMessage = subscribe('chat.message', (event) => {
      setItems((current) =>
        current.some((message) => message.id === event.message.id)
          ? current
          : [...current, { ...event.message, deleted: false }],
      );
      if (following.current && document.visibilityState === 'visible') {
        markRead(event.message.createdAt);
      }
    });
    const offDeleted = subscribe('chat.deleted', (event) => {
      setItems((current) =>
        current.map((message) =>
          message.id === event.id ? { ...message, deleted: true, body: '', mentions: [] } : message,
        ),
      );
    });
    return () => {
      offMessage();
      offDeleted();
    };
  }, [subscribe, markRead]);

  // Suivre le bas quand on y est ; garder sa place quand on charge l'historique.
  React.useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    if (restoreFrom.current !== null) {
      node.scrollTop = node.scrollHeight - restoreFrom.current;
      restoreFrom.current = null;
    } else if (following.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [items]);

  function onScroll() {
    const node = scroller.current;
    if (!node) return;
    following.current =
      node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_THRESHOLD_PX;
    const last = items.at(-1);
    if (following.current && last) markRead(last.createdAt);
  }

  async function loadOlder() {
    const oldest = items[0];
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    const response = await fetch(
      `/api/chat/messages?before=${encodeURIComponent(oldest.createdAt)}`,
    );
    setLoadingOlder(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return;
    }
    const page = (await response.json()) as { items: Message[]; hasMore: boolean };
    restoreFrom.current = scroller.current
      ? scroller.current.scrollHeight - scroller.current.scrollTop
      : null;
    setItems((current) => [
      ...page.items.filter((message) => !current.some((known) => known.id === message.id)),
      ...current,
    ]);
    setMore(page.hasMore);
  }

  async function send(body: string): Promise<boolean> {
    setError(null);
    const response = await fetch('/api/chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as ApiError;
      setError(payload.error?.message ?? tc('http.failure', { status: response.status }));
      return false;
    }
    const message = (await response.json()) as Message;
    following.current = true;
    setItems((current) =>
      current.some((known) => known.id === message.id) ? current : [...current, message],
    );
    return true;
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeletePending(true);
    const response = await fetch(`/api/chat/messages/${deleting.id}`, { method: 'DELETE' });
    setDeletePending(false);
    if (!response.ok && response.status !== 404) {
      const payload = (await response.json().catch(() => ({}))) as ApiError;
      setError(payload.error?.message ?? tc('http.failure', { status: response.status }));
    } else {
      const id = deleting.id;
      setItems((current) =>
        current.map((message) =>
          message.id === id ? { ...message, deleted: true, body: '', mentions: [] } : message,
        ),
      );
    }
    setDeleting(null);
  }

  const today = dayKey(now, format.timezone);
  const yesterday = dayKey(new Date(Date.parse(now) - 86_400_000).toISOString(), format.timezone);
  const dayLabel = (iso: string) => {
    const key = dayKey(iso, format.timezone);
    if (key === today) return t('day.today');
    if (key === yesterday) return t('day.yesterday');
    return formatDateTimeWith(iso, format, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: format.timezone,
    });
  };
  const timeOf = (iso: string) =>
    formatDateTimeWith(iso, format, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: format.timezone,
    });

  const team = sortByPresence(members, statusOf);
  const online = team.filter((member) => statusOf(member.id) !== 'offline').length;

  return (
    <div className="card flex h-[calc(100dvh-230px)] min-h-[440px] overflow-hidden p-0">
      <section className="flex min-w-0 flex-1 flex-col">
        {everConnected && !connected ? (
          <Alert variant="warn" className="rounded-none border-x-0 border-t-0">
            {t('offline')}
          </Alert>
        ) : null}
        <div
          ref={scroller}
          onScroll={onScroll}
          role="log"
          aria-live="polite"
          aria-label={t('page.title')}
          className="flex-1 overflow-y-auto px-3 py-3"
        >
          {items.length === 0 ? (
            <EmptyState icon={MessagesSquare} title={t('empty.title')} hint={t('empty.hint')} />
          ) : (
            <div className="flex flex-col">
              <div className="flex justify-center pb-3">
                {more ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={loadingOlder}
                    onClick={() => void loadOlder()}
                  >
                    {t('history.more')}
                  </Button>
                ) : (
                  <span className="t-cap text-text-3">{t('history.start')}</span>
                )}
              </div>
              {items.map((message, index) => {
                const previous = items[index - 1];
                const newDay =
                  !previous ||
                  dayKey(previous.createdAt, format.timezone) !==
                    dayKey(message.createdAt, format.timezone);
                const divider = message.id === dividerId;
                const grouped =
                  !newDay &&
                  !divider &&
                  previous !== undefined &&
                  !previous.deleted &&
                  previous.authorId === message.authorId &&
                  Date.parse(message.createdAt) - Date.parse(previous.createdAt) < GROUP_WITHIN_MS;
                const name = message.authorName ?? t('message.unknownAuthor');
                const mentionsMe = message.mentions.some(
                  (mention) => mention.kind === 'user' && mention.id === me,
                );
                const canDelete = !message.deleted && (message.authorId === me || canModerate);

                return (
                  <React.Fragment key={message.id}>
                    {newDay ? (
                      <div className="my-3 flex items-center gap-3" role="separator">
                        <span className="h-px flex-1 bg-border" />
                        <span className="t-cap font-medium text-text-3">
                          {dayLabel(message.createdAt)}
                        </span>
                        <span className="h-px flex-1 bg-border" />
                      </div>
                    ) : null}
                    {divider ? (
                      <div className="my-2 flex items-center gap-3" role="separator">
                        <span className="h-px flex-1 bg-danger-line" />
                        <span className="t-cap font-semibold text-danger-text">
                          {t('divider.new')}
                        </span>
                      </div>
                    ) : null}
                    <article
                      className={cn(
                        'group relative flex gap-3 rounded-lg px-2 hover:bg-surface-2',
                        grouped ? 'py-0.5' : 'mt-1.5 py-1.5',
                        mentionsMe && 'bg-warn-soft hover:bg-warn-soft',
                      )}
                    >
                      {grouped ? (
                        <time
                          dateTime={message.createdAt}
                          className="t-cap w-8 shrink-0 pt-0.5 text-right text-text-3 opacity-0 group-hover:opacity-100"
                        >
                          {timeOf(message.createdAt)}
                        </time>
                      ) : message.authorId ? (
                        <PresenceAvatar userId={message.authorId} name={name} large />
                      ) : (
                        <span className="av av-lg" aria-hidden>
                          ?
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        {grouped ? null : (
                          <header className="flex items-baseline gap-2">
                            <span className="t-sm font-semibold text-text">
                              {name}
                              {message.authorId === me ? (
                                <span className="font-normal text-text-3">
                                  {' '}
                                  ({t('message.you')})
                                </span>
                              ) : null}
                            </span>
                            <time dateTime={message.createdAt} className="t-cap text-text-3">
                              {timeOf(message.createdAt)}
                            </time>
                          </header>
                        )}
                        {message.deleted ? (
                          <p className="t-sm text-text-3 italic">{t('message.deleted')}</p>
                        ) : (
                          <MessageBody
                            body={message.body}
                            mentions={message.mentions}
                            directory={directory}
                            me={me}
                          />
                        )}
                      </div>
                      {canDelete ? (
                        <span className="absolute top-1 right-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                          <IconButton
                            label={t('message.delete')}
                            size="icon-sm"
                            onClick={() => setDeleting(message)}
                          >
                            <Trash2 />
                          </IconButton>
                        </span>
                      ) : null}
                    </article>
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>
        {error ? (
          <Alert variant="destructive" className="mx-3 mb-0">
            {error}
          </Alert>
        ) : null}
        <Composer directory={directory} onSend={send} />
      </section>

      <aside className="hidden w-64 shrink-0 flex-col border-l border-border lg:flex">
        <div className="border-b border-border px-4 py-3">
          <h2 className="t-sm font-semibold text-text">{t('members.title')}</h2>
          <p className="t-cap text-text-3">{t('members.online', { count: online })}</p>
        </div>
        <ul className="flex-1 overflow-y-auto p-2">
          {team.map((member) => (
            <li key={member.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
              <PresenceAvatar userId={member.id} name={member.name} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="t-sm truncate text-text">
                  {member.name}
                  {member.id === me ? (
                    <span className="text-text-3"> ({t('message.you')})</span>
                  ) : null}
                </span>
                <span className="t-cap flex items-center gap-1.5 text-text-3">
                  <PresenceDot status={statusOf(member.id)} inline />
                  {t(`presence.${statusOf(member.id)}`)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </aside>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        level="trace"
        icon={<Trash2 />}
        title={t('message.delete')}
        confirmLabel={tc('delete')}
        pending={deletePending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
