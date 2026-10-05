/**
 * The emojis the chat offers: a selection, not the whole of Unicode.
 *
 * Four families are enough for an operations team — react, approve, signal a
 * fire, celebrate a production release. Each emoji passes `isChatEmoji()`
 * (checked by a test): what is offered, the server accepts.
 */

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🚀', '✅', '🙏'] as const;

// The grid reads better at twelve per line than at one per line.
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

/** The last chosen emojis, in this browser. Empty if storage is unavailable. */
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
    // A comfort preference: without storage, we do without.
  }
}
