import type { ChatMention } from './realtime.js';

/**
 * The team chat: the format of a message and its mentions.
 *
 * A mention is not "@prod-1" text searched for afterwards: it is a
 * `<@target:ID>` token in the body, set by the composer when one picks from the
 * list. Renaming the machine therefore does not break the link, and two objects
 * with the same name are not confused. The label at the time is kept next to it
 * (`mentions[].label`) so that a message stays readable even when the object has
 * disappeared, or the reader is not allowed to open it.
 */

export const CHAT_DEFAULT_CHANNEL = 'general';
export const CHAT_MESSAGE_MAX = 4000;
export const CHAT_PAGE_SIZE = 50;
/** Different emojis on one message: beyond this, the reactions line becomes unreadable. */
export const CHAT_REACTIONS_MAX = 20;
/** Length of a reply's quote. */
export const CHAT_QUOTE_LENGTH = 140;

/**
 * An emoji, and nothing else: a pictogram, possibly followed by its variations
 * (skin tone, presentation selector, ZWJ joins, flags). A reaction is never free
 * text — otherwise it becomes a second message channel, without moderation.
 */
const EMOJI_PATTERN =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)(?:[\u200D\uFE0F\u20E3]|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u{E0020}-\u{E007F}])*$/u;

export function isChatEmoji(value: string): boolean {
  return value.length > 0 && value.length <= 32 && EMOJI_PATTERN.test(value);
}

export const CHAT_MENTION_KINDS = ['user', 'target', 'app'] as const;
export type ChatMentionKind = (typeof CHAT_MENTION_KINDS)[number];

/** `<@user:abc123>`, `<@target:uuid>`, `<@app:uuid>`. */
const MENTION_TOKEN = /<@(user|target|app):([A-Za-z0-9_-]{1,64})>/g;

export function mentionToken(kind: ChatMentionKind, id: string): string {
  return `<@${kind}:${id}>`;
}

export type ChatSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; kind: ChatMentionKind; id: string };

/** The body split into text and mentions, in order. */
export function parseChatBody(body: string): ChatSegment[] {
  const segments: ChatSegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(MENTION_TOKEN)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ type: 'text', text: body.slice(cursor, index) });
    segments.push({ type: 'mention', kind: match[1] as ChatMentionKind, id: match[2] ?? '' });
    cursor = index + match[0].length;
  }
  if (cursor < body.length) segments.push({ type: 'text', text: body.slice(cursor) });
  return segments;
}

/** The mentioned objects, without duplicates, in order of appearance. */
export function mentionedIn(body: string): Array<{ kind: ChatMentionKind; id: string }> {
  const seen = new Set<string>();
  const found: Array<{ kind: ChatMentionKind; id: string }> = [];
  for (const segment of parseChatBody(body)) {
    if (segment.type !== 'mention') continue;
    const key = `${segment.kind}:${segment.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ kind: segment.kind, id: segment.id });
  }
  return found;
}

/**
 * Replaces the tokens the author was not allowed to set — an unknown object, or
 * outside their permissions — with plain text. A message must not be able to
 * forge a link to what its author does not see.
 */
export function keepMentions(
  body: string,
  allowed: ReadonlyArray<Pick<ChatMention, 'kind' | 'id' | 'label'>>,
): string {
  return body.replace(MENTION_TOKEN, (token, kind: string, id: string) => {
    const hit = allowed.find((mention) => mention.kind === kind && mention.id === id);
    return hit ? token : '@?';
  });
}

/** The raw text, tokens replaced by their label — for a toast, a preview. */
export function chatPlainText(body: string, mentions: readonly ChatMention[]): string {
  return body.replace(MENTION_TOKEN, (_token, kind: string, id: string) => {
    const hit = mentions.find((mention) => mention.kind === kind && mention.id === id);
    return `@${hit?.label ?? '?'}`;
  });
}
