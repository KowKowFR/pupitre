'use client';

import type { PresenceChoice, PresenceStatus } from '@pupitre/core';
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { useT } from '@/i18n/client';
import { chat as messages } from '@/i18n/messages/chat';
import { PresenceDot } from './presence';
import { useOptionalRealtime } from './realtime-provider';

type Option = { value: 'auto' | PresenceChoice; dot: PresenceStatus; help: string };

/**
 * « Mon statut », en sous-menu du menu utilisateur : automatique (en ligne,
 * absent après inactivité), absent, ne pas déranger. Le choix vaut pour tous
 * les onglets et survit à leur fermeture.
 */
export function StatusSubMenu() {
  const t = useT(messages);
  const realtime = useOptionalRealtime();
  if (!realtime) return null;
  const current = realtime.choice ?? 'auto';
  const mine = realtime.statusOf(realtime.me);
  const options: Option[] = [
    { value: 'auto', dot: 'online', help: t('presence.auto.help') },
    { value: 'away', dot: 'away', help: t('presence.away.help') },
    { value: 'busy', dot: 'busy', help: t('presence.busy.help') },
  ];

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger meta={<PresenceDot status={mine} inline />}>
        {t('presence.menu')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(value) =>
            void realtime.setChoice(value === 'auto' ? null : (value as PresenceChoice))
          }
        >
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <span className="flex items-start gap-2">
                <PresenceDot status={option.dot} inline className="mt-1.5" />
                <span className="flex flex-col">
                  <span>
                    {option.value === 'auto' ? t('presence.auto') : t(`presence.${option.value}`)}
                  </span>
                  <span className="t-cap text-text-3">{option.help}</span>
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
