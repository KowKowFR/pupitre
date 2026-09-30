import 'server-only';
import { mentionedIn, type ChatMention } from '@pupitre/core';
import { getApplication, getTarget, listChatMembers } from '@pupitre/db';
import type { AuthContext } from './rbac';

/**
 * Ce que la discussion lit autour d'elle : les mentions qu'un auteur peut
 * poser, et l'annuaire qu'un lecteur peut parcourir.
 *
 * La règle est la même dans les deux sens : on ne mentionne, et on ne voit
 * proposer, que ce qu'on a le droit d'ouvrir. Une personne se mentionne
 * toujours ; une machine demande `target:read`, une application
 * `application:read`.
 */

/** Les mentions d'un corps, vérifiées une à une, avec leur libellé du moment. */
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
  /** Ce que la mention affiche : un nom, une machine, un slug. */
  label: string;
  /** Ce qu'on tape aussi pour la retrouver : l'e-mail, l'hôte. */
  hint: string | null;
};
