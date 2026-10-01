/**
 * Les emojis proposés par la discussion : une sélection, pas l'Unicode entier.
 *
 * Quatre familles suffisent à une équipe d'exploitation — réagir, approuver,
 * signaler un feu, fêter une mise en production. Chaque emoji passe
 * `isChatEmoji()` (vérifié par un test) : ce qu'on propose, le serveur
 * l'accepte.
 */

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🚀', '✅', '🙏'] as const;

// La grille se lit mieux à douze par ligne qu'à un par ligne.
// prettier-ignore
export const EMOJI_GROUPS = [
  {
    key: 'smileys',
    icon: '😀',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '🙂', '😉', '😊', '😇',
      '🥰', '😍', '😘', '😋', '😜', '🤪', '🤔', '🤨', '😐', '😑', '😶', '🙄',
      '😏', '😬', '😌', '😴', '😷', '🤒', '🤯', '🥳', '😎', '🤓', '🧐', '😕',
      '😟', '😮', '😲', '😳', '🥺', '😢', '😭', '😱', '😤', '😡', '🤬', '💀',
    ],
  },
  {
    key: 'gestures',
    icon: '👍',
    emojis: [
      '👍', '👎', '👌', '✌️', '🤞', '🤝', '👏', '🙌', '🙏', '💪', '👀', '🫡',
      '🤷', '🤦', '👋', '✋', '☝️', '👉', '👈', '👆', '👇', '🫶', '🧠', '🦾',
    ],
  },
  {
    key: 'ops',
    icon: '🚀',
    emojis: [
      '🚀', '🔥', '✅', '❌', '⚠️', '🐛', '🔧', '🛠️', '⚙️', '💻', '🖥️', '🗄️',
      '📦', '🔒', '🔑', '🧪', '📈', '📉', '📊', '🕐', '⏳', '🔄', '💾', '🧯',
      '🚨', '🛡️', '🌐', '☁️', '🐳', '☸️', '🏗️', '🧹',
    ],
  },
  {
    key: 'symbols',
    icon: '❤️',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💯', '✨', '⭐', '🎉', '🎊',
      '🏆', '💡', '📌', '❓', '❗', '💬', '👑', '🍾', '☕', '🍕', '🍺', '🌙',
    ],
  },
] as const;

export type EmojiGroupKey = (typeof EMOJI_GROUPS)[number]['key'];

const RECENT_KEY = 'pupitre.emoji.recent';
const RECENT_MAX = 16;

/** Les derniers emojis choisis, dans ce navigateur. Vide si le stockage est indisponible. */
export function recentEmojis(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(emoji: string): void {
  try {
    const next = [emoji, ...recentEmojis().filter((item) => item !== emoji)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Préférence de confort : sans stockage, on s'en passe.
  }
}
