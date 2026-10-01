'use client';

/* eslint-disable @next/next/no-img-element -- aperçus locaux (blob:) des images à joindre */

import * as React from 'react';
import {
  AlertTriangle,
  Boxes,
  CornerUpLeft,
  ImagePlus,
  LoaderCircle,
  SendHorizontal,
  Server,
  Smile,
  X,
} from 'lucide-react';
import {
  CHAT_IMAGES_PER_MESSAGE,
  CHAT_MESSAGE_MAX,
  mentionToken,
  type ChatQuote,
} from '@pupitre/core';
import { PresenceAvatar } from '@/components/realtime/presence';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { chat as messages } from '@/i18n/messages/chat';
import type { DirectoryEntry } from '@/lib/chat';
import { prepareChatImage, type PreparedImage } from '@/lib/image-prep';
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
 *
 * Les images se joignent par le bouton, se collent (une capture d'écran) ou se
 * déposent sur la zone. Chacune est réduite et réencodée tout de suite, dans le
 * navigateur — l'aperçu montre l'état de cette préparation. Une image seule
 * suffit à faire un message.
 */

type Pending = {
  key: string;
  /** Aperçu local de l'original. */
  url: string;
  state: 'preparing' | 'ready' | 'failed';
  prepared: PreparedImage | null;
};

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
  onSend: (body: string, images: PreparedImage[]) => Promise<boolean>;
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
  const [images, setImages] = React.useState<Pending[]>([]);
  const [imageNotice, setImageNotice] = React.useState<string | null>(null);
  const [dropping, setDropping] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const urls = React.useRef(new Set<string>());
  /** Où poser le curseur au prochain rendu : dans le même cadre que le texte, pas après. */
  const caret = React.useRef<number | null>(null);

  const candidates = suggest ? candidatesFor(directory, suggest.query) : [];
  const open = suggest !== null;
  const over = text.trim().length - CHAT_MESSAGE_MAX;
  const ready = images.filter((image) => image.state === 'ready');
  const preparing = images.some((image) => image.state === 'preparing');
  const sendable = (text.trim().length > 0 || ready.length > 0) && over <= 0 && !preparing;

  // Les aperçus locaux ne survivent pas au compositeur.
  React.useEffect(() => {
    const owned = urls.current;
    return () => {
      for (const url of owned) URL.revokeObjectURL(url);
      owned.clear();
    };
  }, []);

  function release(url: string) {
    URL.revokeObjectURL(url);
    urls.current.delete(url);
  }

  function addFiles(files: readonly File[]) {
    const pictures = files.filter((file) => file.type.startsWith('image/'));
    if (pictures.length === 0) return;
    const room = CHAT_IMAGES_PER_MESSAGE - images.length;
    setImageNotice(
      pictures.length > room ? t('composer.images.max', { max: CHAT_IMAGES_PER_MESSAGE }) : null,
    );
    for (const file of pictures.slice(0, Math.max(0, room))) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const url = URL.createObjectURL(file);
      urls.current.add(url);
      setImages((current) => [...current, { key, url, state: 'preparing', prepared: null }]);
      prepareChatImage(file).then(
        (prepared) =>
          setImages((current) =>
            current.map((image) =>
              image.key === key ? { ...image, state: 'ready', prepared } : image,
            ),
          ),
        () =>
          setImages((current) =>
            current.map((image) => (image.key === key ? { ...image, state: 'failed' } : image)),
          ),
      );
    }
    area.current?.focus();
  }

  function removeImage(key: string) {
    setImages((current) => {
      const target = current.find((image) => image.key === key);
      if (target) release(target.url);
      return current.filter((image) => image.key !== key);
    });
    setImageNotice(null);
  }

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
    if (!sendable || sending) return;
    setSending(true);
    const sent = await onSend(
      body,
      ready.flatMap((image) => (image.prepared ? [image.prepared] : [])),
    );
    setSending(false);
    if (sent) {
      setText('');
      setPicked([]);
      setSuggest(null);
      for (const image of images) release(image.url);
      setImages([]);
      setImageNotice(null);
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
    <div
      className={cn(
        'relative border-t border-border p-3',
        dropping && 'bg-accent-soft outline-2 -outline-offset-4 outline-accent outline-dashed',
      )}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDropping(false);
        addFiles([...event.dataTransfer.files]);
      }}
    >
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          addFiles([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />
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
            <span className="t-cap truncate text-text-2">
              {replyTo.excerpt || t('message.image')}
            </span>
          </span>
          <IconButton label={t('reply.cancel')} size="icon-sm" onClick={onCancelReply}>
            <X />
          </IconButton>
        </div>
      ) : null}

      {images.length > 0 ? (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label={t('composer.images')}>
          {images.map((image) => (
            <li key={image.key} className="relative size-16">
              <img
                src={image.url}
                alt=""
                className={cn(
                  'size-16 rounded-lg border border-border object-cover',
                  image.state !== 'ready' && 'opacity-50',
                )}
              />
              {image.state === 'preparing' ? (
                <span
                  className="absolute inset-0 grid place-items-center"
                  aria-label={t('composer.images.preparing')}
                >
                  <LoaderCircle aria-hidden className="size-5 animate-spin text-text" />
                </span>
              ) : image.state === 'failed' ? (
                <span
                  className="absolute inset-0 grid place-items-center text-danger-text"
                  title={t('composer.images.failed')}
                  aria-label={t('composer.images.failed')}
                >
                  <AlertTriangle aria-hidden className="size-5" />
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => removeImage(image.key)}
                aria-label={t('composer.images.remove')}
                className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-border bg-surface text-text-2 shadow-sm hover:text-text focus-visible:shadow-focus focus-visible:outline-none"
              >
                <X aria-hidden className="size-3" />
              </button>
            </li>
          ))}
        </ul>
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
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.length === 0) return;
            // Une capture d'écran collée : on la joint. Du texte collé avec, lui, passe.
            if (!event.clipboardData.types.includes('text/plain')) event.preventDefault();
            addFiles(files);
          }}
        />
        <IconButton
          label={t('composer.attach')}
          variant="ghost"
          disabled={images.length >= CHAT_IMAGES_PER_MESSAGE}
          onClick={() => fileInput.current?.click()}
        >
          <ImagePlus />
        </IconButton>
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
          disabled={!sendable}
          onClick={() => void submit()}
        >
          <SendHorizontal />
        </IconButton>
      </div>
      <p
        className={cn('t-cap mt-1.5', over > 0 || imageNotice ? 'text-danger-text' : 'text-text-3')}
      >
        {over > 0
          ? t('composer.tooLong', { count: over })
          : (imageNotice ?? (dropping ? t('composer.drop') : t('composer.hint')))}
      </p>
    </div>
  );
}
