'use client';

import * as React from 'react';
import { CornerUpLeft, ExternalLink, Plus, SmilePlus, Trash2 } from 'lucide-react';
import type { ChatAttachment, ChatMessage, ChatReaction } from '@pupitre/core';
import { PresenceAvatar } from '@/components/realtime/presence';
import type { Member } from '@/components/realtime/realtime-provider';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton, Tooltip } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { chat as messages } from '@/i18n/messages/chat';
import type { DirectoryEntry } from '@/lib/chat';
import { QUICK_REACTIONS } from '@/lib/emoji';
import { cn } from '@/lib/utils';
import { EmojiPicker } from './emoji-picker';
import { MessageBody } from './message-body';

export type ThreadMessage = ChatMessage & { deleted: boolean };

/**
 * A message of the thread: its quote if it replies to another, its body, its
 * reactions. On hover (or keyboard focus), the actions bar: react, reply, delete.
 */
export function ChatMessageItem({
  message,
  grouped,
  me,
  members,
  directory,
  time,
  canDelete,
  highlighted,
  onReply,
  onReact,
  onDelete,
  onJump,
}: {
  message: ThreadMessage;
  /** The continuation of a message from the same author: no avatar, no name. */
  grouped: boolean;
  me: string;
  members: readonly Member[];
  directory: readonly DirectoryEntry[];
  time: string;
  canDelete: boolean;
  /** Just targeted from a quote: it blinks once. */
  highlighted: boolean;
  onReply: (message: ThreadMessage) => void;
  onReact: (message: ThreadMessage, emoji: string) => void;
  onDelete: (message: ThreadMessage) => void;
  onJump: (id: string) => void;
}) {
  const t = useT(messages);
  const [reacting, setReacting] = React.useState(false);
  const [more, setMore] = React.useState(false);
  const name = message.authorName ?? t('message.unknownAuthor');
  const mentionsMe =
    message.mentions.some((mention) => mention.kind === 'user' && mention.id === me) ||
    message.replyTo?.authorId === me;

  function react(emoji: string) {
    setReacting(false);
    setMore(false);
    onReact(message, emoji);
  }

  return (
    <article
      id={`chat-${message.id}`}
      className={cn(
        'group relative flex gap-2.5 rounded-lg px-2 transition-colors hover:bg-surface-2',
        grouped ? 'py-0.5' : 'mt-2 py-1',
        mentionsMe && !message.deleted && 'bg-warn-soft hover:bg-warn-soft',
        highlighted && 'chat-flash',
      )}
    >
      {grouped ? (
        <time
          dateTime={message.createdAt}
          className="w-6 shrink-0 pt-0.5 text-right text-[10.5px] leading-[18px] text-text-3 opacity-0 group-hover:opacity-100"
        >
          {time}
        </time>
      ) : message.authorId ? (
        <span className="pt-0.5">
          <PresenceAvatar userId={message.authorId} name={name} />
        </span>
      ) : (
        <span className="av mt-0.5" aria-hidden>
          ?
        </span>
      )}

      <div className="min-w-0 flex-1">
        {grouped ? null : (
          <header className="flex items-baseline gap-1.5">
            <span className="t-sm truncate font-semibold text-text">{name}</span>
            <time dateTime={message.createdAt} className="t-cap shrink-0 text-text-3">
              {time}
            </time>
          </header>
        )}

        {message.replyTo ? (
          <button
            type="button"
            onClick={() => message.replyTo && onJump(message.replyTo.id)}
            aria-label={t('reply.jump')}
            className="my-0.5 flex w-full min-w-0 flex-col rounded-md border-l-2 border-border-strong bg-surface-2 px-2 py-1 text-left hover:border-accent"
          >
            <span className="t-cap font-semibold text-text-2">
              {message.replyTo.authorName ?? t('message.unknownAuthor')}
            </span>
            <span className="t-cap truncate text-text-3">
              {message.replyTo.deleted ? (
                <i>{t('quote.deleted')}</i>
              ) : (
                message.replyTo.excerpt || t('message.image')
              )}
            </span>
          </button>
        ) : null}

        {message.deleted ? (
          <p className="t-sm text-text-3 italic">{t('message.deleted')}</p>
        ) : message.body ? (
          <MessageBody
            body={message.body}
            mentions={message.mentions}
            directory={directory}
            me={me}
          />
        ) : null}

        {!message.deleted && message.attachments.length > 0 ? (
          <Attachments items={message.attachments} />
        ) : null}

        {message.reactions.length > 0 ? (
          <Reactions reactions={message.reactions} me={me} members={members} onToggle={react} />
        ) : null}
      </div>

      {message.deleted ? null : (
        <div
          className={cn(
            'absolute -top-3 right-2 flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5 shadow-sm',
            'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
            (reacting || more) && 'opacity-100',
          )}
        >
          <Popover
            open={reacting}
            onOpenChange={(open) => {
              setReacting(open);
              if (!open) setMore(false);
            }}
          >
            <PopoverTrigger asChild>
              <IconButton label={t('reaction.add')} size="icon-sm">
                <SmilePlus />
              </IconButton>
            </PopoverTrigger>
            <PopoverContent side="top" align="end" className="w-auto p-1">
              {more ? (
                <EmojiPicker onPick={react} />
              ) : (
                <div className="flex items-center gap-0.5">
                  {QUICK_REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={emoji}
                      onClick={() => react(emoji)}
                      className="grid size-8 place-items-center rounded-md text-[18px] hover:bg-surface-2 focus-visible:shadow-focus focus-visible:outline-none"
                    >
                      {emoji}
                    </button>
                  ))}
                  <IconButton
                    label={t('reaction.more')}
                    size="icon-sm"
                    onClick={() => setMore(true)}
                  >
                    <Plus />
                  </IconButton>
                </div>
              )}
            </PopoverContent>
          </Popover>
          <IconButton label={t('reply.action')} size="icon-sm" onClick={() => onReply(message)}>
            <CornerUpLeft />
          </IconButton>
          {canDelete ? (
            <IconButton
              label={t('message.delete')}
              size="icon-sm"
              onClick={() => onDelete(message)}
            >
              <Trash2 />
            </IconButton>
          ) : null}
        </div>
      )}
    </article>
  );
}

/**
 * The reactions: an emoji, a number, and who — in the tooltip. One's own is
 * highlighted; clicking it removes it, clicking someone else's joins it.
 */
function Reactions({
  reactions,
  me,
  members,
  onToggle,
}: {
  reactions: readonly ChatReaction[];
  me: string;
  members: readonly Member[];
  onToggle: (emoji: string) => void;
}) {
  const t = useT(messages);
  const nameOf = (id: string) =>
    id === me ? t('reaction.you') : (members.find((member) => member.id === id)?.name ?? '—');

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {reactions.map((reaction) => {
        const mine = reaction.userIds.includes(me);
        const who = t('reaction.by', {
          names: reaction.userIds.map(nameOf).join(', '),
          emoji: reaction.emoji,
        });
        return (
          <Tooltip key={reaction.emoji} content={who}>
            <button
              type="button"
              aria-pressed={mine}
              aria-label={who}
              onClick={() => onToggle(reaction.emoji)}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[12px] leading-none',
                mine
                  ? 'border-accent-line bg-accent-soft text-accent-text'
                  : 'border-border bg-surface text-text-2 hover:border-border-strong',
              )}
            >
              <span className="text-[14px]">{reaction.emoji}</span>
              <span className="num font-medium">{reaction.userIds.length}</span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

const attachmentUrl = (id: string) => `/api/chat/attachments/${id}`;

/**
 * A message's images. A single one shows in its shape, bounded; several make a
 * mosaic of squares. The room is reserved before loading — the dimensions come
 * with the message —, so the thread does not jump. A click opens the image large.
 */
function Attachments({ items }: { items: readonly ChatAttachment[] }) {
  const t = useT(messages);
  const [open, setOpen] = React.useState<ChatAttachment | null>(null);
  const single = items.length === 1;

  return (
    <>
      <div className={cn('mt-1.5 max-w-[320px]', !single && 'grid grid-cols-2 gap-1')}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setOpen(item)}
            aria-label={t('image.open')}
            className="block overflow-hidden rounded-lg border border-border bg-surface-2 focus-visible:shadow-focus focus-visible:outline-none"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- authenticated API image */}
            <img
              src={attachmentUrl(item.id)}
              alt=""
              width={item.width}
              height={item.height}
              loading="lazy"
              decoding="async"
              className={cn(
                'block transition-opacity hover:opacity-90',
                single ? 'h-auto max-h-72 w-auto max-w-full' : 'aspect-square w-full object-cover',
              )}
            />
          </button>
        ))}
      </div>

      <Dialog open={open !== null} onOpenChange={(next) => (next ? undefined : setOpen(null))}>
        {/* At the image's size: no white bands around a small screenshot, no overflow
            of a large one. */}
        <DialogContent className="flex w-fit max-w-[calc(100vw-32px)] min-w-[280px] flex-col items-center gap-3 p-3">
          <DialogTitle className="sr-only">{t('image.viewer')}</DialogTitle>
          {open ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- authenticated API image */}
              <img
                src={attachmentUrl(open.id)}
                alt=""
                width={open.width}
                height={open.height}
                className="h-auto max-h-[calc(100dvh-min(180px,20vh)-96px)] w-auto max-w-[min(1200px,calc(100vw-56px))] rounded-md"
              />
              <span className="flex w-full items-center justify-between gap-2">
                <span className="t-cap mono text-text-3">
                  {open.width} × {open.height} · {Math.max(1, Math.round(open.bytes / 1024))} Kio
                </span>
                <a
                  href={attachmentUrl(open.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-ghost btn-sm"
                >
                  <ExternalLink aria-hidden />
                  {t('image.original')}
                </a>
              </span>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
