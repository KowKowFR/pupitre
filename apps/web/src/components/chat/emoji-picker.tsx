'use client';

import * as React from 'react';
import { Clock } from 'lucide-react';
import { useT } from '@/i18n/client';
import { chat as messages } from '@/i18n/messages/chat';
import { EMOJI_GROUPS, recentEmojis, rememberEmoji, type EmojiGroupKey } from '@/lib/emoji';
import { cn } from '@/lib/utils';

/**
 * La grille d'emojis : les récents d'abord (s'il y en a), puis quatre
 * familles. Flèches pour se déplacer, Entrée pour choisir — la grille est un
 * vrai `grid` ARIA.
 */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const t = useT(messages);
  const [recent] = React.useState(recentEmojis);
  const [group, setGroup] = React.useState<'recent' | EmojiGroupKey>(
    recent.length > 0 ? 'recent' : 'smileys',
  );
  const emojis =
    group === 'recent'
      ? recent
      : (EMOJI_GROUPS.find((candidate) => candidate.key === group)?.emojis ?? []);
  const grid = React.useRef<HTMLDivElement>(null);

  function pick(emoji: string) {
    rememberEmoji(emoji);
    onPick(emoji);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const buttons = [...(grid.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 8, ArrowUp: -8 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    buttons[Math.min(buttons.length - 1, Math.max(0, index + step))]?.focus();
  }

  const tabs: Array<{ key: 'recent' | EmojiGroupKey; icon: React.ReactNode }> = [
    ...(recent.length > 0 ? [{ key: 'recent' as const, icon: <Clock className="size-4" /> }] : []),
    ...EMOJI_GROUPS.map((candidate) => ({ key: candidate.key, icon: candidate.icon })),
  ];

  return (
    <div className="flex w-[296px] flex-col">
      <div
        role="tablist"
        aria-label={t('emoji.label')}
        className="flex gap-1 border-b border-border p-1.5"
      >
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={group === tab.key}
            aria-label={t(`emoji.group.${tab.key}`)}
            title={t(`emoji.group.${tab.key}`)}
            onClick={() => setGroup(tab.key)}
            className={cn(
              'grid size-8 place-items-center rounded-md text-[17px] text-text-2 hover:bg-surface-2',
              group === tab.key && 'bg-accent-soft text-accent-text',
            )}
          >
            {tab.icon}
          </button>
        ))}
      </div>
      <div
        ref={grid}
        role="grid"
        aria-label={t(`emoji.group.${group}`)}
        onKeyDown={onKeyDown}
        className="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto p-1.5"
      >
        {emojis.map((emoji) => (
          <button
            key={emoji}
            type="button"
            role="gridcell"
            aria-label={emoji}
            onClick={() => pick(emoji)}
            className="grid size-8 place-items-center rounded-md text-[20px] leading-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:shadow-focus focus-visible:outline-none"
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
