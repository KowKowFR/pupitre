import 'server-only';
import { mentionedIn, type ChatMention } from '@pupitre/core';
import { getApplication, getTarget, listChatMembers } from '@pupitre/db';
import type { AuthContext } from './rbac';

/**
 * What the chat reads around it: the mentions an author can set, and the
 * directory a reader can browse.
 *
 * The rule is the same both ways: one only mentions, and is only offered, what
 * one is allowed to open. A person can always be mentioned; a machine requires
 * `target:read`, an application `application:read`.
 */

/** A body's mentions, checked one by one, with their current label. */
export async function resolveMentions(body: string, auth: AuthContext): Promise<ChatMention[]> {
  const wanted = mentionedIn(body);
  if (wanted.length === 0) return [];
  const members = wanted.some((mention) => mention.kind === 'user') ? await listChatMembers() : [];

  const resolved: ChatMention[] = [];
  for (const mention of wanted.slice(0, 20)) {
    if (mention.kind === 'user') {
      const member = members.find((candidate) => candidate.id === mention.id);
      if (member) resolved.push({ ...mention, label: member.name });
    } else if (mention.kind === 'target' && auth.can('target:read')) {
      const target = await getTarget(mention.id).catch(() => null);
      if (target) resolved.push({ ...mention, label: target.name });
    } else if (mention.kind === 'app' && auth.can('application:read')) {
      const application = await getApplication(mention.id).catch(() => null);
      if (application) resolved.push({ ...mention, label: application.slug });
    }
  }
  return resolved;
}

export type DirectoryEntry = {
  kind: ChatMention['kind'];
  id: string;
  /** What the mention shows: a name, a machine, a slug. */
  label: string;
  /** What one also types to find it: the email, the host. */
  hint: string | null;
};
