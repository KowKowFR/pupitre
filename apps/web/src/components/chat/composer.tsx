'use client';

import * as React from 'react';
import { Boxes, CornerUpLeft, SendHorizontal, Server, Smile, X } from 'lucide-react';
import { CHAT_MESSAGE_MAX, mentionToken, type ChatQuote } from '@pupitre/core';
import { PresenceAvatar } from '@/components/realtime/presence';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { chat as messages } from '@/i18n/messages/chat';
import type { DirectoryEntry } from '@/lib/chat';
import { cn } from '@/lib/utils';
import { EmojiPicker } from './emoji-picker';

/**
 * Le compositeur. `@` ouvre la liste des personnes, machines et applications
 * que la session peut voir ; choisir insère le nom en clair dans la zone de
 * saisie et retient l'objet. À l'envoi, chaque nom retenu devient un jeton
 * `<@kind:id>` — un « @prod-1 » tapé sans passer par la liste reste du texte.
 *
 * Entrée envoie, Maj + Entrée va à la ligne. Dans la liste : flèches, Entrée
 * ou Tab pour choisir, Échap pour fermer. Échap, hors de la liste, annule la
 * réponse en cours.
 */

type Suggest = { query: string; start: number; index: number };

const MENTION_QUERY = /(?:^|\s)@([^\s@]{0,32})$/u;
const KIND_ORDER = { user: 0, target: 1, app: 2 } as const;

function candidatesFor(directory: readonly DirectoryEntry[], query: string): DirectoryEntry[] {
  const needle = query.toLowerCase();
  return directory
    .map((entry) => {
      const label = entry.label.toLowerCase();
      const hint = entry.hint?.toLowerCase() ?? '';
      const rank = label.startsWith(needle)
        ? 0
        : label.includes(needle)
          ? 1
          : hint.includes(needle)
            ? 2
            : -1;
      return { entry, rank };
    })
    .filter((candidate) => candidate.rank >= 0)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        KIND_ORDER[a.entry.kind] - KIND_ORDER[b.entry.kind] ||
        a.entry.label.localeCompare(b.entry.label),
    )
    .slice(0, 8)
    .map((candidate) => candidate.entry);
}

/** Le texte saisi, noms retenus remplacés par leurs jetons — les plus longs d'abord. */
function encode(text: string, picked: readonly DirectoryEntry[]): string {
  const unique = [...new Map(picked.map((entry) => [`${entry.kind}:${entry.id}`, entry])).values()];
  unique.sort((a, b) => b.label.length - a.label.length);
  let body = text;
  for (const entry of unique) {
    body = body.split(`@${entry.label}`).join(mentionToken(entry.kind, entry.id));
  }
  return body;
}

export function Composer({
  directory,
  onSend,
  replyTo,
  onCancelReply,
  autoFocus = false,
}: {
  directory: readonly DirectoryEntry[];
  onSend: (body: string) => Promise<boolean>;
  /** Le message auquel on répond, montré au-dessus de la saisie. */
  replyTo: ChatQuote | null;
  onCancelReply: () => void;
  autoFocus?: boolean;
}) {
  const t = useT(messages);
  const listId = React.useId();
  const area = React.useRef<HTMLTextAreaElement>(null);
  const [text, setText] = React.useState('');
  const [picked, setPicked] = React.useState<DirectoryEntry[]>([]);
  const [suggest, setSuggest] = React.useState<Suggest | null>(null);
  const [sending, setSending] = React.useState(false);
  const [emojiOpen, setEmojiOpen] = React.useState(false);
  /** Où poser le curseur au prochain rendu : dans le même cadre que le texte, pas après. */
  const caret = React.useRef<number | null>(null);

  const candidates = suggest ? candidatesFor(directory, suggest.query) : [];
  const open = suggest !== null;
  const over = text.trim().length - CHAT_MESSAGE_MAX;

  React.useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus]);

  // Répondre ramène le curseur dans la saisie.
  React.useEffect(() => {
    if (replyTo) area.current?.focus();
  }, [replyTo]);

  /** L'emoji entre là où est le curseur, et le curseur repart juste après. */
  function insertEmoji(emoji: string) {
    const node = area.current;
    const start = node?.selectionStart ?? text.length;
    const end = node?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    caret.current = start + emoji.length;
    setText(next);
    setEmojiOpen(false);
  }

  // Hauteur au contenu, de une à huit lignes — et le curseur là où on l'a demandé.
  React.useLayoutEffect(() => {
    const node = area.current;
    if (!node) return;
    if (caret.current !== null) {
      node.focus();
      node.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 8 * 21 + 18)}px`;
  }, [text]);

  function detect(value: string, caret: number) {
    const match = value.slice(0, caret).match(MENTION_QUERY);
    if (!match) {
      setSuggest(null);
      return;
    }
    const query = match[1] ?? '';
    setSuggest({ query, start: caret - query.length - 1, index: 0 });
  }

  function pick(entry: DirectoryEntry) {
    const node = area.current;
    if (!suggest || !node) return;
    const end = node.selectionStart;
    const inserted = `@${entry.label} `;
    const next = text.slice(0, suggest.start) + inserted + text.slice(end);
    caret.current = suggest.start + inserted.length;
    setText(next);
    setPicked((current) => [...current, entry]);
    setSuggest(null);
  }

  async function submit() {
    const body = encode(text.trim(), picked);
    if (body.length === 0 || over > 0 || sending) return;
    setSending(true);
    const sent = await onSend(body);
    setSending(false);
    if (sent) {
      setText('');
      setPicked([]);
      setSuggest(null);
      area.current?.focus();
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (open && candidates.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setSuggest((current) =>
          current
            ? { ...current, index: (current.index + step + candidates.length) % candidates.length }
            : current,
        );
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const entry = candidates[suggest?.index ?? 0];
        if (entry) pick(entry);
        return;
      }
    }
    if (open && event.key === 'Escape') {
      event.preventDefault();
      setSuggest(null);
      return;
    }
    if (!open && event.key === 'Escape' && replyTo) {
      event.preventDefault();
      event.stopPropagation();
      onCancelReply();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  const active = open ? candidates[suggest.index] : undefined;

  return (
    <div className="relative border-t border-border p-3">
      {open ? (
        <div className="card absolute bottom-full left-3 z-20 mb-2 w-80 overflow-hidden p-1 shadow-md">
          <p className="t-cap px-2 pt-1 pb-1.5 text-text-3">{t('suggest.label')}</p>
          {candidates.length === 0 ? (
            <p className="t-sm px-2 pb-2 text-text-3">{t('suggest.none')}</p>
          ) : (
            <ul id={listId} role="listbox" aria-label={t('suggest.label')}>
              {candidates.map((entry, index) => (
                <li
                  key={`${entry.kind}:${entry.id}`}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === suggest.index}
                  // La souris choisit sans voler le focus de la zone de saisie.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(entry);
                  }}
                  onMouseEnter={() =>
                    setSuggest((current) => (current ? { ...current, index } : current))
                  }
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5',
                    index === suggest.index && 'bg-surface-2',
                  )}
                >
                  {entry.kind === 'user' ? (
                    <PresenceAvatar userId={entry.id} name={entry.label} />
                  ) : (
                    <span className="grid size-6 place-items-center rounded-md border border-border text-text-2">
                      {entry.kind === 'target' ? (
                        <Server aria-hidden className="size-3.5" />
                      ) : (
                        <Boxes aria-hidden className="size-3.5" />
                      )}
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className={cn('t-sm truncate text-text', entry.kind !== 'user' && 'mono')}
                    >
                      {entry.label}
                    </span>
                    {entry.hint ? (
                      <span className="t-cap truncate text-text-3">{entry.hint}</span>
                    ) : null}
                  </span>
                  <span className="t-cap shrink-0 text-text-3">{t(`suggest.${entry.kind}`)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {replyTo ? (
        <div className="mb-2 flex items-start gap-2 rounded-md border-l-2 border-accent bg-accent-soft py-1.5 pr-1 pl-2.5">
          <CornerUpLeft aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent-text" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="t-cap font-semibold text-accent-text">
              {t('reply.to', { name: replyTo.authorName ?? t('message.unknownAuthor') })}
            </span>
            <span className="t-cap truncate text-text-2">{replyTo.excerpt}</span>
          </span>
          <IconButton label={t('reply.cancel')} size="icon-sm" onClick={onCancelReply}>
            <X />
          </IconButton>
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <label className="sr-only" htmlFor={`${listId}-input`}>
          {t('composer.label')}
        </label>
        <textarea
          id={`${listId}-input`}
          ref={area}
          rows={1}
          value={text}
          placeholder={t('composer.placeholder')}
          className="input min-h-[38px] flex-1 resize-none py-2 leading-[21px]"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={active && suggest ? `${listId}-${suggest.index}` : undefined}
          aria-autocomplete="list"
          onChange={(event) => {
            setText(event.target.value);
            detect(event.target.value, event.target.selectionStart);
          }}
          onClick={(event) => detect(text, event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onBlur={() => setSuggest(null)}
        />
        <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
          <PopoverTrigger asChild>
            <IconButton label={t('composer.emoji')} variant="ghost">
              <Smile />
            </IconButton>
          </PopoverTrigger>
          <PopoverContent side="top" align="end" className="w-auto p-0">
            <EmojiPicker onPick={insertEmoji} />
          </PopoverContent>
        </Popover>
        <IconButton
          label={t('composer.send')}
          variant="default"
          loading={sending}
          disabled={text.trim().length === 0 || over > 0}
          onClick={() => void submit()}
        >
          <SendHorizontal />
        </IconButton>
      </div>
      <p className={cn('t-cap mt-1.5', over > 0 ? 'text-danger-text' : 'text-text-3')}>
        {over > 0 ? t('composer.tooLong', { count: over }) : t('composer.hint')}
      </p>
    </div>
  );
}
