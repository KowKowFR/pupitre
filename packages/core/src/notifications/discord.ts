import type { ChannelConfig } from './catalog.js';
import {
  renderDigestItemLine,
  renderDigestOmission,
  type NotificationDigest,
} from './digest.js';
import { NOTIFICATION_SEVERITY_LABELS, type NotificationMessage } from './message.js';
import { httpCall, jsonField } from './http.js';
import {
  NotificationError,
  type FetchLike,
  type NotificationChannel,
  type NotificationTestResult,
  type ResolvedChannelConfig,
} from './types.js';

/**
 * Discord, par un webhook de salon.
 *
 * Un `embed` plutôt qu'un message de texte : la barre de couleur à gauche rend
 * la gravité lisible d'un coup d'œil dans un salon qui défile, et les champs
 * s'alignent au lieu de se perdre dans un paragraphe.
 *
 * Les bornes de l'API sont dures et silencieuses — un dépassement rend un 400
 * sans dire lequel des dix champs est en cause. On tronque donc ici, une fois,
 * plutôt que de découvrir la limite en production.
 */

const LIMIT = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, fields: 25 };

/**
 * Lignes détaillées d'un résumé dans un salon.
 *
 * Quinze : un salon Discord se lit sur un écran large et se remonte facilement,
 * on peut donc y être plus généreux que sur Telegram — mais pas cinquante, sous
 * peine de noyer le reste du salon sous un seul message. Les lignes tues sont
 * annoncées, comme ailleurs.
 */
const DIGEST_LINES = 15;

/** Couleur de la barre latérale, en entier — c'est la forme qu'attend Discord. */
const COLOR: Record<NotificationMessage['severity'], number> = {
  info: 0x3b6fd4,
  warning: 0xb7791f,
  critical: 0xc0392b,
};

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function str(config: ChannelConfig, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : '';
}

export class DiscordChannel implements NotificationChannel {
  readonly kind = 'discord' as const;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly timeoutMs: number,
  ) {}

  private url(resolved: ResolvedChannelConfig): string {
    const url = str(resolved.secrets, 'webhookUrl');
    if (url.length === 0) {
      throw new NotificationError('aucune URL de webhook configurée', this.kind, 'config');
    }
    return url;
  }

  /**
   * Un `GET` sur l'URL du webhook rend sa description sans rien déposer dans le
   * salon : c'est la sonde exacte qu'il faut, et elle valide à la fois l'URL et
   * le jeton qu'elle contient.
   */
  async test(resolved: ResolvedChannelConfig): Promise<NotificationTestResult> {
    try {
      const result = await httpCall({
        channel: this.kind,
        fetch: this.fetchImpl,
        url: this.url(resolved),
        method: 'GET',
        timeoutMs: this.timeoutMs,
        secrets: resolved.secrets,
      });
      const name = jsonField(result.text, 'name');
      return {
        ok: true,
        detail: name ? `Webhook « ${name} » reconnu par Discord.` : 'Webhook reconnu par Discord.',
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof NotificationError ? error.message : String(error),
      };
    }
  }

  async send(resolved: ResolvedChannelConfig, message: NotificationMessage): Promise<void> {
    const username = str(resolved.config, 'username');

    await httpCall({
      channel: this.kind,
      fetch: this.fetchImpl,
      url: this.url(resolved),
      method: 'POST',
      timeoutMs: this.timeoutMs,
      secrets: resolved.secrets,
      body: {
        ...(username.length > 0 ? { username } : {}),
        embeds: [
          {
            title: clamp(message.title, LIMIT.title),
            description: clamp(message.body, LIMIT.description),
            color: COLOR[message.severity],
            ...(message.url ? { url: message.url } : {}),
            timestamp: message.occurredAt,
            fields: message.fields.slice(0, LIMIT.fields).map((field) => ({
              name: clamp(field.label, LIMIT.fieldName),
              value: clamp(field.value, LIMIT.fieldValue),
              // Les valeurs sont des identifiants et des messages d'erreur :
              // sur deux colonnes elles seraient tronquées à l'affichage.
              inline: false,
            })),
            footer: {
              text: clamp(
                `${message.instance} · ${NOTIFICATION_SEVERITY_LABELS[message.severity]}`,
                LIMIT.fieldValue,
              ),
            },
          },
        ],
      },
    });
  }

  /**
   * Le résumé : un seul `embed`, la liste dans la `description` plutôt que dans
   * des `fields`.
   *
   * Les `fields` d'un embed sont faits pour des paires étiquette/valeur courtes ;
   * quinze d'entre eux empilés produisent un pavé illisible, et l'API en refuse
   * plus de vingt-cinq. Une liste à puces dans la description se lit comme une
   * liste — ce qu'elle est.
   */
  async sendDigest(resolved: ResolvedChannelConfig, digest: NotificationDigest): Promise<void> {
    const username = str(resolved.config, 'username');
    const shown = digest.items.slice(0, DIGEST_LINES);
    const omission = renderDigestOmission(digest.count - shown.length);

    const description = [
      digest.body,
      '',
      ...shown.map((item) => `• ${renderDigestItemLine(item)}`),
      ...(omission ? ['', `*${omission}*`] : []),
    ].join('\n');

    await httpCall({
      channel: this.kind,
      fetch: this.fetchImpl,
      url: this.url(resolved),
      method: 'POST',
      timeoutMs: this.timeoutMs,
      secrets: resolved.secrets,
      body: {
        ...(username.length > 0 ? { username } : {}),
        embeds: [
          {
            title: clamp(digest.title, LIMIT.title),
            description: clamp(description, LIMIT.description),
            color: COLOR[digest.severity],
            ...(digest.url ? { url: digest.url } : {}),
            timestamp: digest.occurredAt,
            fields: [],
            footer: {
              text: clamp(
                `${digest.instance} · ${NOTIFICATION_SEVERITY_LABELS[digest.severity]} · ${digest.count} alertes regroupées`,
                LIMIT.fieldValue,
              ),
            },
          },
        ],
      },
    });
  }
}
