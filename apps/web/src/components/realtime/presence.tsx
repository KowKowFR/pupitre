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
  const image = realtime?.members.find((member) => member.id === userId)?.image ?? null;
  if (!realtime) return <Avatar name={name} large={large} />;
  return (
    <span className="presence">
      <Avatar name={name} src={image} large={large} />
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
 * La barre haute : qui d'autre est là (quelques avatars, puis « +3 »). Un clic
 * ouvre la liste complète de l'équipe, et de là, la discussion. La discussion
 * elle-même vit dans sa bulle, en bas à droite de chaque écran.
 */
export function TeamPresence() {
  const t = useT(messages);
  const { members, me, statusOf, setChatOpen } = useRealtime();
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
                    <Avatar name={member.name} src={member.image} />
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
                    <Avatar name={member.name} src={member.image} />
                    <PresenceDot status={statusOf(member.id)} />
                  </span>
                  <span className="t-sm min-w-0 flex-1 truncate text-text">{member.name}</span>
                  <span className="t-cap text-text-3">{t(`presence.${statusOf(member.id)}`)}</span>
                </li>
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
