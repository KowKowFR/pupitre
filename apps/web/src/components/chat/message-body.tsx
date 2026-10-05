'use client';

import Link from 'next/link';
import { Boxes, Server } from 'lucide-react';
import { parseChatBody, type ChatMention, type ChatMentionKind } from '@pupitre/core';
import { useT } from '@/i18n/client';
import { chat as messages } from '@/i18n/messages/chat';
import type { DirectoryEntry } from '@/lib/chat';
import { cn } from '@/lib/utils';

/**
 * A message's body: text, never HTML — React escapes it — and mentions rendered
 * as chips. Only `http(s)://` addresses become links; nothing else is
 * interpreted.
 */

const URL_PATTERN = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_PATTERN);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noreferrer noopener"
            className="link break-all"
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

const MENTION_HREF: Record<Exclude<ChatMentionKind, 'user'>, (id: string) => string> = {
  target: (id) => `/targets?target=${id}`,
  app: (id) => `/applications?app=${id}`,
};

function Mention({
  kind,
  id,
  mentions,
  directory,
  me,
}: {
  kind: ChatMentionKind;
  id: string;
  mentions: readonly ChatMention[];
  directory: readonly DirectoryEntry[];
  me: string;
}) {
  const t = useT(messages);
  // Today's name if we know it, otherwise the one from the message's day.
  const known = directory.find((entry) => entry.kind === kind && entry.id === id);
  const label =
    known?.label ??
    mentions.find((mention) => mention.kind === kind && mention.id === id)?.label ??
    t('mention.unknown');

  if (kind === 'user') {
    return (
      <span
        className={cn(
          'rounded px-1 font-medium',
          id === me ? 'bg-warn-soft text-warn-text' : 'bg-accent-soft text-accent-text',
        )}
      >
        @{label}
      </span>
    );
  }

  const Icon = kind === 'target' ? Server : Boxes;
  const chip = (
    <>
      <Icon aria-hidden className="size-3 shrink-0" />
      {label}
    </>
  );
  const className =
    'mono inline-flex translate-y-[1px] items-center gap-1 rounded border border-border bg-surface-2 px-1.5 text-[12.5px] leading-[18px] text-text';
  // An object the reader cannot open stays named, without a link.
  return known ? (
    <Link
      href={MENTION_HREF[kind](id) as never}
      className={cn(className, 'hover:border-accent-line')}
    >
      {chip}
    </Link>
  ) : (
    <span className={className}>{chip}</span>
  );
}

export function MessageBody({
  body,
  mentions,
  directory,
  me,
}: {
  body: string;
  mentions: readonly ChatMention[];
  directory: readonly DirectoryEntry[];
  me: string;
}) {
  return (
    <p className="t-sm break-words whitespace-pre-wrap text-text">
      {parseChatBody(body).map((segment, index) =>
        segment.type === 'text' ? (
          <Linkified key={index} text={segment.text} />
        ) : (
          <Mention
            key={index}
            kind={segment.kind}
            id={segment.id}
            mentions={mentions}
            directory={directory}
            me={me}
          />
        ),
      )}
    </p>
  );
}
