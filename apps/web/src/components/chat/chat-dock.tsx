'use client';

import * as React from 'react';
import { ChevronDown, MessagesSquare, Trash2, Users, X } from 'lucide-react';
import { CHAT_QUOTE_LENGTH, chatPlainText, type ChatQuote } from '@pupitre/core';
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
import { extensionOf, type PreparedImage } from '@/lib/image-prep';
import { cn } from '@/lib/utils';
import { ChatMessageItem, type ThreadMessage } from './chat-message';
import { Composer } from './composer';

type ApiError = { error?: { message?: string } };

/** Deux messages du même auteur à moins de cinq minutes se lisent comme un seul bloc. */
const GROUP_WITHIN_MS = 5 * 60_000;
/** À moins de ce nombre de pixels du bas, on suit le fil. */
const FOLLOW_THRESHOLD_PX = 80;
/** Durée du « +1 » qui s'envole de la bulle. */
const POP_MS = 1_200;

function dayKey(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

type ThreadLoad =
  | { ok: true; items: ThreadMessage[]; hasMore: boolean; directory: DirectoryEntry[] }
  | { ok: false; status: number; message: string | null };

/** Le fil et l'annuaire des mentions, en une fois. Ne lève jamais. */
async function fetchThread(): Promise<ThreadLoad> {
  try {
    const [thread, people] = await Promise.all([
      fetch('/api/chat/messages'),
      fetch('/api/chat/directory'),
    ]);
    if (!thread.ok) {
      const body = (await thread.json().catch(() => ({}))) as ApiError;
      return { ok: false, status: thread.status, message: body.error?.message ?? null };
    }
    const page = (await thread.json()) as { items: ThreadMessage[]; hasMore: boolean };
    const directory = people.ok ? ((await people.json()) as { items: DirectoryEntry[] }).items : [];
    return { ok: true, items: page.items, hasMore: page.hasMore, directory };
  } catch {
    // Réseau coupé : rouvrir la bulle réessaie.
    return { ok: false, status: 0, message: null };
  }
}

/** Le premier des `unread` derniers messages des autres : là où commence le nouveau. */
function firstUnreadId(items: readonly ThreadMessage[], me: string, unread: number): string | null {
  if (unread <= 0) return null;
  const fromOthers = items.filter((message) => message.authorId !== me);
  return fromOthers.at(-Math.min(unread, fromOthers.length))?.id ?? null;
}

/** L'heure, à la minute : « aujourd'hui » et « hier » basculent à minuit sans rechargement. */
function useClock(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function quoteOf(message: ThreadMessage): ChatQuote {
  const text = chatPlainText(message.body, message.mentions).replace(/\s+/g, ' ');
  return {
    id: message.id,
    authorId: message.authorId,
    authorName: message.authorName,
    excerpt: text.length > CHAT_QUOTE_LENGTH ? `${text.slice(0, CHAT_QUOTE_LENGTH - 1)}…` : text,
    deleted: false,
  };
}

/**
 * La discussion, toujours à portée : une bulle en bas à droite de chaque
 * écran, qui ouvre le fil par-dessus la page — on garde sous les yeux le
 * déploiement dont on parle.
 *
 * La bulle porte les non-lus (rouge quand l'un d'eux s'adresse à vous) et
 * laisse s'envoler un « +1 » à chaque message qui arrive. Le fil se charge à
 * la première ouverture, puis reste à jour en direct, même fermé : le rouvrir
 * est instantané. Il vit dans le layout, il survit donc à la navigation.
 */
export function ChatDock({
  canModerate,
  format,
}: {
  canModerate: boolean;
  format: FormatSettings;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const realtime = useRealtime();
  const {
    me,
    members,
    statusOf,
    subscribe,
    clearUnread,
    connected,
    unread,
    mentions,
    chatOpen,
    setChatOpen,
  } = realtime;

  const [loaded, setLoaded] = React.useState(false);
  const [items, setItems] = React.useState<ThreadMessage[]>([]);
  const [more, setMore] = React.useState(false);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [directory, setDirectory] = React.useState<DirectoryEntry[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [view, setView] = React.useState<'thread' | 'team'>('thread');
  const [replyTo, setReplyTo] = React.useState<ChatQuote | null>(null);
  const [deleting, setDeleting] = React.useState<ThreadMessage | null>(null);
  const [deletePending, setDeletePending] = React.useState(false);
  const [highlight, setHighlight] = React.useState<string | null>(null);
  const [dividerId, setDividerId] = React.useState<string | null>(null);
  const [pops, setPops] = React.useState<string[]>([]);
  const [everConnected, setEverConnected] = React.useState(false);
  if (connected && !everConnected) setEverConnected(true);
  const now = useClock();

  const scroller = React.useRef<HTMLDivElement>(null);
  const bubble = React.useRef<HTMLButtonElement>(null);
  const following = React.useRef(true);
  const restoreFrom = React.useRef<number | null>(null);
  const unreadRef = React.useRef(unread);
  const fetching = React.useRef(false);
  const panelId = React.useId();

  React.useEffect(() => {
    unreadRef.current = unread;
  }, [unread]);

  // À l'ouverture, le séparateur « Nouveaux » se pose devant le premier non-lu
  // — tout de suite si le fil est déjà là, sinon au chargement (`load`).
  const [wasOpen, setWasOpen] = React.useState(chatOpen);
  if (chatOpen !== wasOpen) {
    setWasOpen(chatOpen);
    setDividerId(chatOpen && loaded ? firstUnreadId(items, me, unread) : null);
  }

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

  // ── Première ouverture : le fil et l'annuaire des mentions ─────────────
  // Rien n'est écrit avant la réponse : le chargement se lit dans `loaded`.
  const load = React.useCallback(() => {
    if (fetching.current) return;
    fetching.current = true;
    void fetchThread().then((result) => {
      fetching.current = false;
      if (!result.ok) {
        setError(result.message ?? tc('http.failure', { status: result.status }));
        return;
      }
      setDirectory(result.directory);
      setItems(result.items);
      setMore(result.hasMore);
      setDividerId(firstUnreadId(result.items, me, unreadRef.current));
      setError(null);
      setLoaded(true);
    });
  }, [tc, me]);

  React.useEffect(() => {
    if (chatOpen && !loaded) load();
  }, [chatOpen, loaded, load]);
  const loading = chatOpen && !loaded && error === null;

  // Ouvert et chargé : on suit le bas, et tout est lu.
  React.useEffect(() => {
    if (!chatOpen || !loaded) return;
    following.current = true;
    const last = items.at(-1);
    if (last) markRead(last.createdAt);
    else clearUnread();
    // Une fois par ouverture, quand le fil est là.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpen, loaded]);

  // ── Le direct : messages, effacements, réactions ───────────────────────
  React.useEffect(() => {
    const offMessage = subscribe('chat.message', (event) => {
      // Fermée : un « +1 » s'envole de la bulle.
      if (!chatOpen && event.message.authorId !== me) {
        const pop = event.message.id;
        setPops((current) => [...current.slice(-2), pop]);
        setTimeout(() => setPops((current) => current.filter((item) => item !== pop)), POP_MS);
      }
      setItems((current) =>
        current.some((message) => message.id === event.message.id)
          ? current
          : [...current, { ...event.message, deleted: false }],
      );
      if (
        chatOpen &&
        following.current &&
        document.visibilityState === 'visible' &&
        event.message.authorId !== me
      ) {
        markRead(event.message.createdAt);
      }
    });
    const offDeleted = subscribe('chat.deleted', (event) => {
      setItems((current) =>
        current.map((message) =>
          message.id === event.id
            ? { ...message, deleted: true, body: '', mentions: [], reactions: [] }
            : message,
        ),
      );
      setReplyTo((current) => (current?.id === event.id ? null : current));
    });
    const offReactions = subscribe('chat.reactions', (event) => {
      setItems((current) =>
        current.map((message) =>
          message.id === event.messageId ? { ...message, reactions: event.reactions } : message,
        ),
      );
    });
    return () => {
      offMessage();
      offDeleted();
      offReactions();
    };
  }, [subscribe, markRead, chatOpen, me]);

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
  }, [items, chatOpen, view, replyTo]);

  function onScroll() {
    const node = scroller.current;
    if (!node) return;
    following.current =
      node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_THRESHOLD_PX;
    const last = items.at(-1);
    if (following.current && last && unread > 0) markRead(last.createdAt);
  }

  function close() {
    setChatOpen(false);
    setReplyTo(null);
    bubble.current?.focus();
  }

  async function loadOlder(): Promise<ThreadMessage[]> {
    const oldest = items[0];
    if (!oldest || loadingOlder) return [];
    setLoadingOlder(true);
    const response = await fetch(
      `/api/chat/messages?before=${encodeURIComponent(oldest.createdAt)}`,
    );
    setLoadingOlder(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return [];
    }
    const page = (await response.json()) as { items: ThreadMessage[]; hasMore: boolean };
    restoreFrom.current = scroller.current
      ? scroller.current.scrollHeight - scroller.current.scrollTop
      : null;
    setItems((current) => [
      ...page.items.filter((message) => !current.some((known) => known.id === message.id)),
      ...current,
    ]);
    setMore(page.hasMore);
    return page.items;
  }

  function jump(id: string) {
    const node = document.getElementById(`chat-${id}`);
    if (!node) return;
    following.current = false;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlight(id);
    setTimeout(() => setHighlight((current) => (current === id ? null : current)), 1_600);
  }

  async function send(body: string, images: PreparedImage[]): Promise<boolean> {
    setError(null);
    let request: RequestInit;
    if (images.length > 0) {
      // Des images : un formulaire multipart, que le serveur relit octet par octet.
      const form = new FormData();
      form.set('body', body);
      if (replyTo) form.set('replyToId', replyTo.id);
      images.forEach((image, index) =>
        form.append('image', image.blob, `image-${index + 1}.${extensionOf(image.blob)}`),
      );
      request = { method: 'POST', body: form };
    } else {
      request = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body, replyToId: replyTo?.id ?? null }),
      };
    }
    const response = await fetch('/api/chat/messages', request).catch(() => null);
    if (!response) {
      setError(tc('http.failure', { status: 0 }));
      return false;
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as ApiError;
      setError(payload.error?.message ?? tc('http.failure', { status: response.status }));
      return false;
    }
    const message = (await response.json()) as ThreadMessage;
    following.current = true;
    setReplyTo(null);
    // Écrire, c'est avoir lu : le serveur a avancé le marqueur, on suit.
    clearUnread();
    setItems((current) =>
      current.some((known) => known.id === message.id) ? current : [...current, message],
    );
    return true;
  }

  async function react(message: ThreadMessage, emoji: string) {
    setError(null);
    const response = await fetch(`/api/chat/messages/${message.id}/reactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ emoji }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as ApiError;
      setError(payload.error?.message ?? tc('http.failure', { status: response.status }));
      return;
    }
    const { reactions } = (await response.json()) as { reactions: ThreadMessage['reactions'] };
    setItems((current) =>
      current.map((known) => (known.id === message.id ? { ...known, reactions } : known)),
    );
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
          message.id === id
            ? { ...message, deleted: true, body: '', mentions: [], reactions: [] }
            : message,
        ),
      );
    }
    setDeleting(null);
  }

  const today = dayKey(new Date(now).toISOString(), format.timezone);
  const yesterday = dayKey(new Date(now - 86_400_000).toISOString(), format.timezone);
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
  const online = team.filter((member) => statusOf(member.id) !== 'offline');
  const bubbleLabel =
    unread > 0
      ? `${t('dock.open')} · ${t('dock.new', { count: unread })}${
          mentions > 0 ? ` ${t('dock.mentions', { count: mentions })}` : ''
        }`
      : t('dock.open');

  return (
    <>
      {chatOpen ? (
        <section
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-label={t('page.title')}
          className="chat-panel"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.defaultPrevented) {
              event.preventDefault();
              close();
            }
          }}
        >
          <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <div className="flex min-w-0 flex-1 flex-col">
              <h2 className="text-[14px] font-semibold text-text">
                {view === 'team' ? t('dock.team') : t('page.title')}
              </h2>
              <p className="t-cap flex items-center gap-1.5 text-text-3">
                <PresenceDot status={online.length > 1 ? 'online' : 'offline'} inline />
                {t('members.online', { count: online.length })}
              </p>
            </div>
            <span className="flex -space-x-1.5" aria-hidden>
              {online
                .filter((member) => member.id !== me)
                .slice(0, 3)
                .map((member) => (
                  <span key={member.id} className="rounded-full ring-2 ring-[var(--surface)]">
                    <PresenceAvatar userId={member.id} name={member.name} />
                  </span>
                ))}
            </span>
            <IconButton
              label={view === 'team' ? t('dock.thread') : t('dock.team')}
              size="icon-sm"
              aria-pressed={view === 'team'}
              onClick={() => setView((current) => (current === 'team' ? 'thread' : 'team'))}
            >
              {view === 'team' ? <MessagesSquare /> : <Users />}
            </IconButton>
            <IconButton label={t('dock.close')} kbd="esc" size="icon-sm" onClick={close}>
              <X />
            </IconButton>
          </header>

          {everConnected && !connected ? (
            <Alert variant="warn" className="rounded-none border-x-0 border-t-0">
              {t('offline')}
            </Alert>
          ) : null}

          {view === 'team' ? (
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
                    <span className="t-cap text-text-3">
                      {t(`presence.${statusOf(member.id)}`)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <div
                ref={scroller}
                onScroll={onScroll}
                role="log"
                aria-live="polite"
                aria-busy={loading}
                aria-label={t('page.title')}
                className="flex-1 overflow-y-auto px-2 pt-2 pb-3"
              >
                {!loaded ? (
                  <p className="t-sm px-2 py-6 text-center text-text-3">
                    {loading ? t('dock.loading') : null}
                  </p>
                ) : items.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                    <span className="grid size-10 place-items-center rounded-full bg-surface-2 text-text-3">
                      <MessagesSquare aria-hidden className="size-5" />
                    </span>
                    <p className="t-sm font-semibold text-text">{t('empty.title')}</p>
                    <p className="t-cap text-text-3">{t('empty.hint')}</p>
                  </div>
                ) : (
                  <div className="flex flex-col">
                    <div className="flex justify-center pb-2">
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
                        !message.replyTo &&
                        previous !== undefined &&
                        !previous.deleted &&
                        previous.authorId === message.authorId &&
                        Date.parse(message.createdAt) - Date.parse(previous.createdAt) <
                          GROUP_WITHIN_MS;
                      return (
                        <React.Fragment key={message.id}>
                          {newDay ? (
                            <div className="my-2 flex items-center gap-3" role="separator">
                              <span className="h-px flex-1 bg-border" />
                              <span className="t-cap font-medium text-text-3">
                                {dayLabel(message.createdAt)}
                              </span>
                              <span className="h-px flex-1 bg-border" />
                            </div>
                          ) : null}
                          {divider ? (
                            <div className="my-1.5 flex items-center gap-3" role="separator">
                              <span className="h-px flex-1 bg-danger-line" />
                              <span className="t-cap font-semibold text-danger-text">
                                {t('divider.new')}
                              </span>
                            </div>
                          ) : null}
                          <ChatMessageItem
                            message={message}
                            grouped={grouped}
                            me={me}
                            members={members}
                            directory={directory}
                            time={timeOf(message.createdAt)}
                            canDelete={!message.deleted && (message.authorId === me || canModerate)}
                            highlighted={highlight === message.id}
                            onReply={(target) => setReplyTo(quoteOf(target))}
                            onReact={(target, emoji) => void react(target, emoji)}
                            onDelete={setDeleting}
                            onJump={jump}
                          />
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
              <Composer
                directory={directory}
                onSend={send}
                replyTo={replyTo}
                onCancelReply={() => setReplyTo(null)}
                autoFocus
              />
            </>
          )}
        </section>
      ) : null}

      <button
        ref={bubble}
        type="button"
        className={cn('chat-bubble', chatOpen && 'is-open')}
        aria-label={chatOpen ? t('dock.close') : bubbleLabel}
        aria-expanded={chatOpen}
        aria-controls={chatOpen ? panelId : undefined}
        onClick={() => (chatOpen ? close() : setChatOpen(true))}
      >
        {chatOpen ? <ChevronDown aria-hidden /> : <MessagesSquare aria-hidden />}
        {!chatOpen && unread > 0 ? (
          <span className={cn('count', mentions > 0 && 'is-mention')} aria-hidden>
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
        {pops.map((pop) => (
          <span key={pop} className="chat-plus" aria-hidden>
            +1
          </span>
        ))}
      </button>

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
    </>
  );
}
