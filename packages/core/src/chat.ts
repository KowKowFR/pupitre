import type { ChatMention } from './realtime.js';

/**
 * La discussion d'équipe : le format d'un message et de ses mentions.
 *
 * Une mention n'est pas du texte « @prod-1 » qu'on recherche après coup :
 * c'est un jeton `<@target:ID>` dans le corps, posé par le compositeur quand
 * on choisit dans la liste. Renommer la machine ne casse donc pas le lien, et
 * deux objets de même nom ne se confondent pas. Le libellé du moment est gardé
 * à côté (`mentions[].label`) pour qu'un message reste lisible même quand
 * l'objet a disparu, ou que le lecteur n'a pas le droit de l'ouvrir.
 */

export const CHAT_DEFAULT_CHANNEL = 'general';
export const CHAT_MESSAGE_MAX = 4000;
export const CHAT_PAGE_SIZE = 50;

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

/** Le corps découpé en texte et en mentions, dans l'ordre. */
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

/** Les objets mentionnés, sans doublon, dans l'ordre d'apparition. */
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
 * Remplace les jetons que l'auteur n'avait pas le droit de poser — un objet
 * inconnu, ou hors de ses permissions — par du texte simple. Un message ne
 * doit pas pouvoir fabriquer un lien vers ce que son auteur ne voit pas.
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

/** Le texte brut, jetons remplacés par leur libellé — pour un toast, un aperçu. */
export function chatPlainText(body: string, mentions: readonly ChatMention[]): string {
  return body.replace(MENTION_TOKEN, (_token, kind: string, id: string) => {
    const hit = mentions.find((mention) => mention.kind === kind && mention.id === id);
    return `@${hit?.label ?? '?'}`;
  });
}
