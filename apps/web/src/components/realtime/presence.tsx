'use client';

import Link from 'next/link';
import type { PresenceStatus } from '@pupitre/core';
import { MessagesSquare } from 'lucide-react';
import { Avatar } from '@/components/ui/data';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useT } from '@/i18n/client';
import { chat as messages } from '@/i18n/messages/chat';
import { cn } from '@/lib/utils';
import { useOptionalRealtime, useRealtime, type Member } from './realtime-provider';

/**
 * Les pastilles de présence : vert en ligne, orange absent, rouge barré ne
 * pas déranger, cercle vide hors ligne. La forme double la couleur, et le mot
 * suit toujours — à côté, ou en nom accessible.
 */

const ORDER: Record<PresenceStatus, number> = { online: 0, busy: 1, away: 2, offline: 3 };

export function PresenceDot({
  status,
  inline = false,
  className,
}: {
  status: PresenceStatus;
  inline?: boolean;
  className?: string;
}) {
  const t = useT(messages);
  return (
    <span
      role="img"
      aria-label={t(`presence.${status}`)}
      title={t(`presence.${status}`)}
      className={cn('presence-dot', `is-${status}`, inline && 'is-inline', className)}
    />
  );
}

/** L'avatar d'une personne, avec sa pastille. Hors du fournisseur, l'avatar seul. */
export function PresenceAvatar({
  userId,
  name,
  large = false,
}: {
  userId: string;
  name: string;
  large?: boolean;
}) {
  const realtime = useOptionalRealtime();
  if (!realtime) return <Avatar name={name} large={large} />;
  return (
    <span className="presence">
      <Avatar name={name} large={large} />
      <PresenceDot status={realtime.statusOf(userId)} />
    </span>
  );
}

/** Les membres, triés : en ligne, occupés, absents, puis hors ligne ; à nom égal, par nom. */
export function sortByPresence(
  members: readonly Member[],
  statusOf: (userId: string) => PresenceStatus,
): Member[] {
  return [...members].sort(
    (a, b) => ORDER[statusOf(a.id)] - ORDER[statusOf(b.id)] || a.name.localeCompare(b.name),
  );
}

/**
 * La barre haute : qui d'autre est là (quelques avatars, puis « +3 »), et
 * l'accès à la discussion avec ses non-lus. Un clic sur les avatars ouvre la
 * liste complète de l'équipe.
 */
export function TeamPresence() {
  const t = useT(messages);
  const { members, me, statusOf, unread, connected } = useRealtime();
  const others = sortByPresence(
    members.filter((member) => member.id !== me),
    statusOf,
  );
  const here = others.filter((member) => statusOf(member.id) !== 'offline');
  const shown = here.slice(0, 4);

  return (
    <div className="flex items-center gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="btn btn-ghost btn-sm gap-2 px-2"
            aria-label={`${t('presence.team')} · ${t('members.online', { count: here.length })}`}
          >
            {shown.length > 0 ? (
              <span className="flex -space-x-1.5">
                {shown.map((member) => (
                  <span key={member.id} className="presence rounded-full ring-2 ring-[var(--bg)]">
                    <Avatar name={member.name} />
                    <PresenceDot status={statusOf(member.id)} />
                  </span>
                ))}
              </span>
            ) : null}
            <span className="t-sm text-text-2">
              {here.length > shown.length
                ? `+${here.length - shown.length}`
                : shown.length === 0
                  ? t('members.online', { count: 0 })
                  : null}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-0">
          <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
            <span className="t-sm font-semibold text-text">{t('presence.team')}</span>
            <span className="t-cap text-text-3">{t('members.online', { count: here.length })}</span>
          </div>
          <ul className="flex max-h-80 flex-col overflow-y-auto py-1">
            {others.length === 0 ? (
              <li className="t-sm px-3 py-2 text-text-3">{t('presence.teamEmpty')}</li>
            ) : (
              others.map((member) => (
                <li key={member.id} className="flex items-center gap-2.5 px-3 py-1.5">
                  <span className="presence">
                    <Avatar name={member.name} />
                    <PresenceDot status={statusOf(member.id)} />
                  </span>
                  <span className="t-sm min-w-0 flex-1 truncate text-text">{member.name}</span>
                  <span className="t-cap text-text-3">{t(`presence.${statusOf(member.id)}`)}</span>
                </li>
              ))
            )}
          </ul>
        </PopoverContent>
      </Popover>

      <Link
        href="/chat"
        className="btn btn-ghost btn-icon relative"
        aria-label={
          unread > 0
            ? `${t('presence.chat')} · ${t('presence.unread', { count: unread })}`
            : t('presence.chat')
        }
        title={t('presence.chat')}
      >
        <MessagesSquare aria-hidden />
        {unread > 0 ? (
          <span className="badge b-count absolute -top-1 -right-1 min-w-[18px] justify-center px-1">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
        {!connected ? <span className="sr-only">{t('offline')}</span> : null}
      </Link>
    </div>
  );
}
