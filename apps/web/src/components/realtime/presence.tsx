'use client';

import type { PresenceStatus } from '@pupitre/core';
import { MessagesSquare } from 'lucide-react';
import { Avatar } from '@/components/ui/data';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useT } from '@/i18n/client';
import { chat as messages } from '@/i18n/messages/chat';
import { cn } from '@/lib/utils';
import { useOptionalRealtime, useRealtime, type Member } from './realtime-provider';

/**
 * The presence chips: green online, orange away, red barred do not disturb,
 * empty circle offline. The shape doubles the color, and the word always follows
 * — beside it, or as an accessible name.
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

/** A person's avatar, with their chip. Outside the provider, the avatar alone. */
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
  const image = realtime?.members.find((member) => member.id === userId)?.image ?? null;
  if (!realtime) return <Avatar name={name} large={large} />;
  return (
    <span className="presence">
      <Avatar name={name} src={image} large={large} />
      <PresenceDot status={realtime.statusOf(userId)} />
    </span>
  );
}

/** The members, sorted: online, busy, away, then offline; with equal status, by name. */
export function sortByPresence(
  members: readonly Member[],
  statusOf: (userId: string) => PresenceStatus,
): Member[] {
  return [...members].sort(
    (a, b) => ORDER[statusOf(a.id)] - ORDER[statusOf(b.id)] || a.name.localeCompare(b.name),
  );
}

/**
 * The top bar: who else is there (a few avatars, then "+3"). A click opens the
 * team's complete list, oneself included, and from there, the chat. The "online"
 * count includes the person looking: alone, they read "1 online", not "0". The
 * chat itself lives in its bubble, at the bottom right of each screen.
 */
export function TeamPresence() {
  const t = useT(messages);
  const { members, me, statusOf, setChatOpen } = useRealtime();
  const self = members.find((member) => member.id === me) ?? null;
  const others = sortByPresence(
    members.filter((member) => member.id !== me),
    statusOf,
  );
  const othersHere = others.filter((member) => statusOf(member.id) !== 'offline');
  const online = othersHere.length + (self && statusOf(self.id) !== 'offline' ? 1 : 0);
  const shown = othersHere.slice(0, 4);

  return (
    <div className="flex items-center gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="btn btn-ghost btn-sm gap-2 px-2"
            aria-label={`${t('presence.team')} · ${t('members.online', { count: online })}`}
          >
            {shown.length > 0 ? (
              <span className="flex -space-x-1.5">
                {shown.map((member) => (
                  <span key={member.id} className="presence rounded-full ring-2 ring-[var(--bg)]">
                    <Avatar name={member.name} src={member.image} />
                    <PresenceDot status={statusOf(member.id)} />
                  </span>
                ))}
              </span>
            ) : null}
            <span className="t-sm text-text-2">
              {othersHere.length > shown.length
                ? `+${othersHere.length - shown.length}`
                : shown.length === 0
                  ? t('members.online', { count: online })
                  : null}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-0">
          <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
            <span className="t-sm font-semibold text-text">{t('presence.team')}</span>
            <span className="t-cap text-text-3">{t('members.online', { count: online })}</span>
          </div>
          <ul className="flex max-h-80 flex-col overflow-y-auto py-1">
            {self ? (
              <TeamMember member={self} status={statusOf(self.id)} you={t('message.you')} />
            ) : null}
            {others.length === 0 ? (
              <li className="t-sm px-3 py-2 text-text-3">{t('presence.teamEmpty')}</li>
            ) : (
              others.map((member) => (
                <TeamMember key={member.id} member={member} status={statusOf(member.id)} />
              ))
            )}
          </ul>
          <div className="border-t border-border p-1.5">
            <PopoverClose asChild>
              <button type="button" className="menu-item w-full" onClick={() => setChatOpen(true)}>
                <MessagesSquare aria-hidden />
                {t('dock.open')}
              </button>
            </PopoverClose>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function TeamMember({
  member,
  status,
  you,
}: {
  member: Member;
  status: PresenceStatus;
  /** "you", for the row of the person looking. */
  you?: string;
}) {
  const t = useT(messages);
  return (
    <li className="flex items-center gap-2.5 px-3 py-1.5">
      <span className="presence">
        <Avatar name={member.name} src={member.image} />
        <PresenceDot status={status} />
      </span>
      <span className="t-sm min-w-0 flex-1 truncate text-text">
        {member.name}
        {you ? <span className="text-text-3"> ({you})</span> : null}
      </span>
      <span className="t-cap text-text-3">{t(`presence.${status}`)}</span>
    </li>
  );
}
