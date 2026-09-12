import type { ChannelConfig } from './catalog.js';
import {
  digestTimeOfDay,
  renderDigestOmission,
  type NotificationDigest,
} from './digest.js';
import { type NotificationMessage } from './message.js';
import { httpCall, jsonField } from './http.js';
import {
  NotificationError,
  type FetchLike,
  type NotificationChannel,
  type NotificationTestResult,
  type ResolvedChannelConfig,
} from './types.js';

/**
 * Telegram, par l'API Bot.
 *
 * ── Les échappements de MarkdownV2 ──────────────────────────────────────────
 * MarkdownV2 exige que **dix-huit** caractères soient précédés d'une barre
 * oblique inverse, y compris le point, le tiret et le point d'exclamation.
 * Autrement dit : n'importe quelle phrase française ordinaire fait échouer
 * l'appel avec un « can't parse entities » incompréhensible, et un message
 * d'incident qui ne part pas est pire qu'un message mal mis en forme.
 *
 * D'où deux règles, tenues ici et nulle part ailleurs :
 *   — tout ce qui vient du message neutre est échappé caractère par caractère ;
 *   — les seuls signes de balisage non échappés sont ceux que *ce fichier*
 *     écrit lui-même (`*` pour le titre, `` ` `` pour les valeurs).
 */

/** Les dix-huit caractères réservés de MarkdownV2, à la lettre. */
const RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(value: string): string {
  return value.replace(RESERVED, (match) => `\\${match}`);
}

const SEVERITY_MARK: Record<NotificationMessage['severity'], string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🔴',
};

function renderMarkdown(message: NotificationMessage): string {
  const lines = [
    `${SEVERITY_MARK[message.severity]} *${escapeMarkdownV2(message.title)}*`,
    '',
    escapeMarkdownV2(message.body),
  ];

  if (message.fields.length > 0) {
    lines.push('');
    for (const field of message.fields) {
      lines.push(`*${escapeMarkdownV2(field.label)}* : \`${escapeMarkdownV2(field.value)}\``);
    }
  }

  if (message.url) {
    // Un lien MarkdownV2 : le libellé s'échappe, l'URL ne s'échappe qu'au
    // parenthésage — l'échapper entièrement casserait la cible.
    lines.push('', `[Ouvrir dans le panel](${message.url.replace(/[()\\]/g, '\\$&')})`);
  }

  lines.push('', `_${escapeMarkdownV2(`${message.instance} · ${message.occurredAt}`)}_`);

  return lines.join('\n');
}

/**
 * Combien de lignes un résumé montre ici.
 *
 * Six, et le chiffre est un arbitrage de canal, pas une constante globale :
 * Telegram s'affiche sur un téléphone, dans un fil qui défile. Cinquante lignes
 * y sont exactement aussi inutilisables que cinquante messages — on aurait
 * déplacé le bruit, pas réduit. Les lignes tues sont **annoncées** ; l'e-mail,
 * lui, les liste toutes.
 */
const DIGEST_LINES = 6;

/** Borne dure de l'API Bot : 4096 caractères. On s'arrête bien avant. */
const TEXT_LIMIT = 3500;

function renderDigestMarkdown(digest: NotificationDigest): string {
  const shown = digest.items.slice(0, DIGEST_LINES);
  const omitted = digest.count - shown.length;

  const lines = [
    `${SEVERITY_MARK[digest.severity]} *${escapeMarkdownV2(digest.title)}*`,
    '',
    // Le corps complet expliquerait l'arbitrage en cinq phrases : sur un
    // téléphone, c'est ce qui pousse la liste hors de l'écran. On garde la
    // seule phrase qui manquerait à la compréhension.
    escapeMarkdownV2(
      `${digest.count} alertes entre ${digestTimeOfDay(digest.windowStartedAt)} et ` +
        `${digestTimeOfDay(digest.windowEndedAt)} (UTC), regroupées.`,
    ),
    '',
  ];

  for (const item of shown) {
    lines.push(
      `• \`${escapeMarkdownV2(digestTimeOfDay(item.occurredAt))}\` ${escapeMarkdownV2(item.label)}` +
        `${item.detail ? ` — ${escapeMarkdownV2(item.detail)}` : ''}`,
    );
  }

  const omission = renderDigestOmission(omitted);
  if (omission) lines.push('', `_${escapeMarkdownV2(omission)}_`);

  if (digest.url) {
    lines.push('', `[Ouvrir dans le panel](${digest.url.replace(/[()\\]/g, '\\$&')})`);
  }

  lines.push('', `_${escapeMarkdownV2(`${digest.instance} · ${digest.occurredAt}`)}_`);

  const text = lines.join('\n');
  return text.length <= TEXT_LIMIT ? text : `${text.slice(0, TEXT_LIMIT - 1)}…`;
}

const DEFAULT_API = 'https://api.telegram.org';

function str(config: ChannelConfig, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : '';
}

export class TelegramChannel implements NotificationChannel {
  readonly kind = 'telegram' as const;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly timeoutMs: number,
  ) {}

  private endpoint(resolved: ResolvedChannelConfig, method: string): string {
    const base = (str(resolved.config, 'apiBaseUrl') || DEFAULT_API).replace(/\/+$/, '');
    const token = str(resolved.secrets, 'botToken');
    if (token.length === 0) {
      throw new NotificationError('aucun jeton de bot configuré', this.kind, 'config');
    }
    return `${base}/bot${token}/${method}`;
  }

  /**
   * `getMe` : la seule sonde de Telegram qui ne poste rien dans la conversation.
   * Elle vérifie que le jeton est valide ; elle ne dit rien de l'identifiant de
   * conversation, que seul un envoi réel peut valider.
   */
  async test(resolved: ResolvedChannelConfig): Promise<NotificationTestResult> {
    try {
      const result = await httpCall({
        channel: this.kind,
        fetch: this.fetchImpl,
        url: this.endpoint(resolved, 'getMe'),
        method: 'GET',
        timeoutMs: this.timeoutMs,
        secrets: resolved.secrets,
      });
      const username = jsonField(result.text, 'result', 'username');
      return {
        ok: true,
        detail: username
          ? `Jeton valide — bot @${username}. L’identifiant de conversation, lui, n’est vérifiable que par un envoi.`
          : 'Jeton accepté par l’API Bot.',
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof NotificationError ? error.message : String(error),
      };
    }
  }

  async send(resolved: ResolvedChannelConfig, message: NotificationMessage): Promise<void> {
    await httpCall({
      channel: this.kind,
      fetch: this.fetchImpl,
      url: this.endpoint(resolved, 'sendMessage'),
      method: 'POST',
      timeoutMs: this.timeoutMs,
      secrets: resolved.secrets,
      body: {
        chat_id: str(resolved.config, 'chatId'),
        text: renderMarkdown(message),
        parse_mode: 'MarkdownV2',
        // L'aperçu déplierait l'URL du panel en pleine conversation, ce qui
        // noie le message sous une vignette sans intérêt.
        link_preview_options: { is_disabled: true },
      },
    });
  }

  /**
   * Le résumé, court par construction : un titre, une phrase, six lignes, et le
   * nombre de lignes tues. C'est le canal où « rester court » l'emporte sur
   * « tout dire » — et où l'honnêteté impose donc de dire ce qu'on ne dit pas.
   */
  async sendDigest(resolved: ResolvedChannelConfig, digest: NotificationDigest): Promise<void> {
    await httpCall({
      channel: this.kind,
      fetch: this.fetchImpl,
      url: this.endpoint(resolved, 'sendMessage'),
      method: 'POST',
      timeoutMs: this.timeoutMs,
      secrets: resolved.secrets,
      body: {
        chat_id: str(resolved.config, 'chatId'),
        text: renderDigestMarkdown(digest),
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      },
    });
  }
}
