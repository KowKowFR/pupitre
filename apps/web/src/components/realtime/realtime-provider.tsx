'use client';

import * as React from 'react';
import {
  PRESENCE_INPUT_THROTTLE_MS,
  chatPlainText,
  realtimeEventSchema,
  type PresenceChoice,
  type PresenceStatus,
  type RealtimeEvent,
  type RealtimeEventType,
} from '@pupitre/core';
import { useT } from '@/i18n/client';
import { chat as messages } from '@/i18n/messages/chat';
import { toast } from '@/lib/toast';

/**
 * Real time, browser side.
 *
 * ── One stream for all the tabs ─────────────────────────────────────────────
 * Over HTTP/1.1 — the panel in development, or behind a proxy that does not speak
 * HTTP/2 — a browser only opens six connections per origin. One SSE stream per
 * tab, and the seventh tab would no longer load anything. The tabs therefore
 * elect a **leader** (Web Locks): it alone opens the stream and relays what it
 * receives to the others (BroadcastChannel). It closes, another takes over.
 * Without these APIs, each tab opens its own — the degraded case of before.
 *
 * ── Presence ────────────────────────────────────────────────────────────────
 * Each tab signals the interactions (keyboard, mouse, back to the foreground), at
 * most once a minute. It is the server that deduces absence from them: no tab
 * has to decide alone that the person left.
 */

type Hello = {
  me: string;
  presence: Record<string, PresenceStatus>;
  unread: number;
  /** Among the unread ones, those addressed to the person (mention, reply). */
  mentions: number;
  choice: PresenceChoice | null;
};

type BusMessage =
  | { kind: 'event'; event: RealtimeEvent }
  | { kind: 'hello'; hello: Hello }
  | { kind: 'connected'; connected: boolean }
  | { kind: 'sync' }
  | { kind: 'read' };

type EventOf<T extends RealtimeEventType> = Extract<RealtimeEvent, { type: T }>;
type Handler = (event: RealtimeEvent) => void;

export type Member = { id: string; name: string; image: string | null };

type RealtimeValue = {
  me: string;
  connected: boolean;
  presence: Record<string, PresenceStatus>;
  members: Member[];
  statusOf: (userId: string) => PresenceStatus;
  choice: PresenceChoice | null;
  setChoice: (choice: PresenceChoice | null) => Promise<void>;
  unread: number;
  mentions: number;
  /** All the tabs reset the counters. */
  clearUnread: () => void;
  /** The chat is open in this tab: visible, it counts as read. */
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  subscribe: <T extends RealtimeEventType>(
    type: T,
    handler: (event: EventOf<T>) => void,
  ) => () => void;
};

const RealtimeContext = React.createContext<RealtimeValue | null>(null);

const BUS = 'pupitre-realtime';
const LOCK = 'pupitre-realtime';
const EVENT_TYPES: RealtimeEventType[] = [
  'presence',
  'chat.message',
  'chat.deleted',
  'chat.reactions',
  'live',
  'activity',
];

export function RealtimeProvider({
  me,
  members,
  initialUnread,
  initialMentions,
  children,
}: {
  me: string;
  members: Member[];
  initialUnread: number;
  initialMentions: number;
  children: React.ReactNode;
}) {
  const t = useT(messages);
  const [connected, setConnected] = React.useState(false);
  const [presence, setPresence] = React.useState<Record<string, PresenceStatus>>({});
  const [unread, setUnread] = React.useState(initialUnread);
  const [mentions, setMentions] = React.useState(initialMentions);
  const [choice, setChoiceState] = React.useState<PresenceChoice | null>(null);
  const [chatOpen, setChatOpenState] = React.useState(false);

  const handlers = React.useRef(new Map<RealtimeEventType, Set<Handler>>());
  const bus = React.useRef<BroadcastChannel | null>(null);
  const reading = React.useRef(false);
  // What the leader broadcasts again to an arriving tab.
  const state = React.useRef<Hello>({
    me,
    presence: {},
    unread: initialUnread,
    mentions: initialMentions,
    choice: null,
  });
  const choiceRef = React.useRef<PresenceChoice | null>(null);
  const tRef = React.useRef(t);
  React.useEffect(() => {
    tRef.current = t;
  }, [t]);

  const applyHello = React.useCallback((hello: Hello) => {
    state.current = hello;
    choiceRef.current = hello.choice;
    setPresence(hello.presence);
    setUnread(hello.unread);
    setMentions(hello.mentions);
    setChoiceState(hello.choice);
  }, []);

  const setChatOpen = React.useCallback((open: boolean) => {
    reading.current = open;
    setChatOpenState(open);
    try {
      sessionStorage.setItem('pupitre.chat.open', open ? '1' : '0');
    } catch {
      // Storage unavailable (private browsing): the state does not survive a reload.
    }
  }, []);

  // Reopened after a reload if it was open: the thread is not lost. At the next
  // frame, not at render: the server rendered it closed.
  React.useEffect(() => {
    let reopen = false;
    try {
      reopen = sessionStorage.getItem('pupitre.chat.open') === '1';
    } catch {
      // Nothing to restore.
    }
    if (!reopen) return;
    const frame = requestAnimationFrame(() => setChatOpen(true));
    return () => cancelAnimationFrame(frame);
  }, [setChatOpen]);

  const receive = React.useCallback(
    (event: RealtimeEvent) => {
      if (event.type === 'presence') {
        state.current = {
          ...state.current,
          presence: { ...state.current.presence, [event.userId]: event.status },
        };
        setPresence((current) => ({ ...current, [event.userId]: event.status }));
      } else if (event.type === 'chat.message' && event.message.authorId !== me) {
        const visible = typeof document !== 'undefined' && document.visibilityState === 'visible';
        if (!(reading.current && visible)) {
          const mentioned = event.message.mentions.some(
            (mention) => mention.kind === 'user' && mention.id === me,
          );
          const repliedTo = event.message.replyTo?.authorId === me;
          state.current = {
            ...state.current,
            unread: state.current.unread + 1,
            mentions: state.current.mentions + (mentioned || repliedTo ? 1 : 0),
          };
          setUnread((count) => count + 1);
          if (mentioned || repliedTo) setMentions((count) => count + 1);
          if ((mentioned || repliedTo) && choiceRef.current !== 'busy' && visible) {
            const name = event.message.authorName ?? '—';
            toast({
              title: tRef.current(mentioned ? 'toast.mention' : 'toast.reply', { name }),
              description:
                chatPlainText(event.message.body, event.message.mentions).slice(0, 160) ||
                tRef.current('message.image'),
              tone: 'accent',
              action: { label: tRef.current('toast.open'), onClick: () => setChatOpen(true) },
            });
          }
        }
      }
      for (const handler of handlers.current.get(event.type) ?? []) {
        try {
          handler(event);
        } catch {
          // A screen in error must not cut the others' stream.
        }
      }
    },
    [me, setChatOpen],
  );

  // ── Transport: a leader, followers ──────────────────────────────────────
  React.useEffect(() => {
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel(BUS) : null;
    bus.current = channel;
    const stop = new AbortController();
    let source: EventSource | null = null;
    let leading = false;

    // After unmounting, nothing goes out any more: the channel is closed, and a late
    // message would throw an error.
    const post = (message: BusMessage) => {
      if (stop.signal.aborted) return;
      channel?.postMessage(message);
    };

    if (channel) {
      channel.onmessage = ({ data }: MessageEvent<BusMessage>) => {
        if (data.kind === 'event') receive(data.event);
        else if (data.kind === 'hello') applyHello(data.hello);
        else if (data.kind === 'connected') setConnected(data.connected);
        else if (data.kind === 'read') {
          state.current = { ...state.current, unread: 0, mentions: 0 };
          setUnread(0);
          setMentions(0);
        } else if (data.kind === 'sync' && leading) {
          post({ kind: 'hello', hello: state.current });
          post({ kind: 'connected', connected: source?.readyState === EventSource.OPEN });
        }
      };
    }

    const lead = () => {
      leading = true;
      source = new EventSource('/api/realtime');
      source.onopen = () => {
        setConnected(true);
        post({ kind: 'connected', connected: true });
      };
      source.onerror = () => {
        // EventSource reconnects on its own; the next `hello` will set everything right.
        setConnected(false);
        post({ kind: 'connected', connected: false });
      };
      source.addEventListener('hello', (message) => {
        const hello = JSON.parse((message as MessageEvent<string>).data) as Hello;
        applyHello(hello);
        post({ kind: 'hello', hello });
      });
      source.addEventListener('bye', () => {
        // Session revoked: the page reloads and goes to sign-in.
        source?.close();
        window.location.reload();
      });
      for (const type of EVENT_TYPES) {
        source.addEventListener(type, (message) => {
          const parsed = realtimeEventSchema.safeParse(
            JSON.parse((message as MessageEvent<string>).data) as unknown,
          );
          if (!parsed.success) return;
          receive(parsed.data);
          post({ kind: 'event', event: parsed.data });
        });
      }
    };

    if (channel && 'locks' in navigator) {
      navigator.locks
        .request(
          LOCK,
          { signal: stop.signal },
          () =>
            new Promise<void>((resolve) => {
              // The lock may arrive after unmounting (StrictMode mounts, unmounts, mounts
              // again): we give it back right away, otherwise this dead mount would keep it
              // and no tab would lead any more.
              if (stop.signal.aborted) {
                resolve();
                return;
              }
              lead();
              stop.signal.addEventListener('abort', () => resolve(), { once: true });
            }),
        )
        .catch(() => undefined);
      // Follower: we ask the leader for the current state, if there is one.
      post({ kind: 'sync' });
    } else {
      lead();
    }

    return () => {
      stop.abort();
      source?.close();
      channel?.close();
      bus.current = null;
    };
  }, [applyHello, receive]);

  // ── Activity: keyboard, mouse, foreground ────────────────────────────────
  React.useEffect(() => {
    let last = Date.now();
    const signal = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - last < PRESENCE_INPUT_THROTTLE_MS) return;
      last = now;
      void fetch('/api/presence', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: true }),
      }).catch(() => undefined);
    };
    const events = ['pointerdown', 'keydown', 'pointermove', 'focus'] as const;
    for (const name of events) window.addEventListener(name, signal, { passive: true });
    document.addEventListener('visibilitychange', signal);
    return () => {
      for (const name of events) window.removeEventListener(name, signal);
      document.removeEventListener('visibilitychange', signal);
    };
  }, []);

  const subscribe = React.useCallback<RealtimeValue['subscribe']>((type, handler) => {
    const set = handlers.current.get(type) ?? new Set<Handler>();
    set.add(handler as Handler);
    handlers.current.set(type, set);
    return () => {
      set.delete(handler as Handler);
    };
  }, []);

  const value = React.useMemo<RealtimeValue>(
    () => ({
      me,
      connected,
      presence,
      members,
      statusOf: (userId) => presence[userId] ?? 'offline',
      choice,
      setChoice: async (next) => {
        choiceRef.current = next;
        setChoiceState(next);
        await fetch('/api/presence', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ choice: next }),
        }).catch(() => undefined);
      },
      unread,
      mentions,
      clearUnread: () => {
        state.current = { ...state.current, unread: 0, mentions: 0 };
        setUnread(0);
        setMentions(0);
        bus.current?.postMessage({ kind: 'read' } satisfies BusMessage);
      },
      chatOpen,
      setChatOpen,
      subscribe,
    }),
    [me, connected, presence, members, choice, unread, mentions, chatOpen, setChatOpen, subscribe],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeValue {
  const value = React.useContext(RealtimeContext);
  if (!value) throw new Error('useRealtime() outside of <RealtimeProvider>');
  return value;
}

/** The same, without requiring the provider — for the components shared with the assistant. */
export function useOptionalRealtime(): RealtimeValue | null {
  return React.useContext(RealtimeContext);
}
