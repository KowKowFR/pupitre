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
 * Le temps réel, côté navigateur.
 *
 * ── Un flux pour tous les onglets ───────────────────────────────────────────
 * En HTTP/1.1 — le panel en développement, ou derrière un proxy qui ne parle
 * pas HTTP/2 — un navigateur n'ouvre que six connexions par origine. Un flux
 * SSE par onglet, et le septième onglet ne chargerait plus rien. Les onglets
 * élisent donc un **meneur** (Web Locks) : lui seul ouvre le flux et relaie ce
 * qu'il reçoit aux autres (BroadcastChannel). Il ferme, un autre prend la
 * main. Sans ces API, chaque onglet ouvre le sien — le cas dégradé d'avant.
 *
 * ── La présence ─────────────────────────────────────────────────────────────
 * Chaque onglet signale les interactions (clavier, souris, retour au premier
 * plan), au plus une fois par minute. C'est le serveur qui en déduit
 * l'absence : aucun onglet n'a à décider seul que la personne est partie.
 */

type Hello = {
  me: string;
  presence: Record<string, PresenceStatus>;
  unread: number;
  /** Parmi les non-lus, ceux qui s'adressent à la personne (mention, réponse). */
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

export type Member = { id: string; name: string };

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
  /** Tous les onglets remettent les compteurs à zéro. */
  clearUnread: () => void;
  /** La discussion est ouverte dans cet onglet : visible, elle vaut lecture. */
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
  // Ce que le meneur rediffuse à un onglet qui arrive.
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
      // Stockage indisponible (navigation privée) : l'état ne survit pas au rechargement.
    }
  }, []);

  // Rouverte après un rechargement si elle l'était : on ne perd pas le fil.
  // Au cadre suivant, pas au rendu : le serveur, lui, l'a rendue fermée.
  React.useEffect(() => {
    let reopen = false;
    try {
      reopen = sessionStorage.getItem('pupitre.chat.open') === '1';
    } catch {
      // Rien à restaurer.
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
              description: chatPlainText(event.message.body, event.message.mentions).slice(0, 160),
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
          // Un écran en erreur ne doit pas couper le flux des autres.
        }
      }
    },
    [me, setChatOpen],
  );

  // ── Transport : un meneur, des suiveurs ─────────────────────────────────
  React.useEffect(() => {
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel(BUS) : null;
    bus.current = channel;
    const stop = new AbortController();
    let source: EventSource | null = null;
    let leading = false;

    // Après le démontage, plus rien ne part : le canal est fermé, et un
    // message tardif lèverait une erreur.
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
        // EventSource se reconnecte seul ; le `hello` suivant remettra tout d'aplomb.
        setConnected(false);
        post({ kind: 'connected', connected: false });
      };
      source.addEventListener('hello', (message) => {
        const hello = JSON.parse((message as MessageEvent<string>).data) as Hello;
        applyHello(hello);
        post({ kind: 'hello', hello });
      });
      source.addEventListener('bye', () => {
        // Session révoquée : la page se recharge et part vers la connexion.
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
              // Le verrou peut arriver après le démontage (StrictMode monte,
              // démonte, remonte) : on le rend aussitôt, sinon ce montage mort
              // le garderait et plus aucun onglet ne mènerait.
              if (stop.signal.aborted) {
                resolve();
                return;
              }
              lead();
              stop.signal.addEventListener('abort', () => resolve(), { once: true });
            }),
        )
        .catch(() => undefined);
      // Suiveur : on demande l'état courant au meneur, s'il y en a un.
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

  // ── Activité : clavier, souris, premier plan ─────────────────────────────
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
  if (!value) throw new Error('useRealtime() hors de <RealtimeProvider>');
  return value;
}

/** Le même, sans exiger le fournisseur — pour les composants partagés avec l'assistant. */
export function useOptionalRealtime(): RealtimeValue | null {
  return React.useContext(RealtimeContext);
}
