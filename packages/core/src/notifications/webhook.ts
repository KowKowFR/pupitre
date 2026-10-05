import {
  DEFAULT_UI_LANGUAGE,
  renderMessage,
  type Translated,
  type UiLanguage,
} from '../i18n.js';
import type { ChannelConfig } from './catalog.js';
import { notificationDigestOmitted, type NotificationDigest } from './digest.js';
import type { NotificationMessage } from './message.js';
import { httpCall } from './http.js';
import {
  NotificationError,
  type FetchLike,
  type NotificationChannel,
  type NotificationTestResult,
  type ResolvedChannelConfig,
} from './types.js';

/**
 * Webhook générique : le message neutre, en JSON, tel quel.
 *
 * C'est le seul canal qui ne met rien en forme — et c'est sa raison d'être :
 * ce qu'il livre est exactement la structure que les trois autres traduisent,
 * ce qui en fait aussi la meilleure façon de vérifier ce que le panel émet.
 *
 * La charge utile est **versionnée**. Un consommateur écrit une fois, et le
 * jour où la forme du message change, il peut le voir plutôt que d'échouer
 * silencieusement sur un champ disparu.
 */
const PAYLOAD_VERSION = 1;

/**
 * Les deux seules phrases de ce canal. La charge utile, elle, n'a pas de
 * langue : c'est du JSON destiné à un programme.
 */
const fr = {
  'probe.none':
    'Un webhook générique n’offre aucune sonde qui ne soit pas une livraison : ' +
    'seul l’envoi d’essai ci-dessous prouve que la cible répond.',
  'error.noUrl': 'aucune URL configurée',
} as const;

const en: Translated<typeof fr> = {
  'probe.none':
    'A plain webhook offers no probe that is not a delivery: only the test send below ' +
    'proves the target answers.',
  'error.noUrl': 'no URL configured',
};

const WEBHOOK_TEXT = { fr, en };

function t(language: UiLanguage, key: keyof typeof fr): string {
  return renderMessage(WEBHOOK_TEXT, language, key);
}

function str(config: ChannelConfig, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : '';
}

export class WebhookChannel implements NotificationChannel {
  readonly kind = 'webhook' as const;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly timeoutMs: number,
  ) {}

  private target(resolved: ResolvedChannelConfig, language: UiLanguage): string {
    const url = str(resolved.config, 'url');
    if (url.length === 0) {
      throw new NotificationError(t(language, 'error.noUrl'), this.kind, 'config');
    }
    return url;
  }

  private headers(
    resolved: ResolvedChannelConfig,
    routing: { event: string; severity: string; digest: boolean },
  ) {
    const token = str(resolved.secrets, 'token');
    return {
      // Trois en-têtes de routage, pour qu'un consommateur puisse trier sans
      // désérialiser le corps — un filtre de passerelle, typiquement. Le
      // troisième distingue un résumé d'une alerte : les deux n'ont pas la même
      // forme, et un consommateur doit pouvoir le savoir avant de parser.
      'X-Control-Plane-Event': routing.event,
      'X-Control-Plane-Severity': routing.severity,
      'X-Control-Plane-Digest': routing.digest ? 'true' : 'false',
      ...(token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  /**
   * Aucune sonde possible : un webhook quelconque n'offre rien d'autre que le
   * POST lui-même, et le sonder reviendrait à livrer. On le dit plutôt que de
   * prétendre avoir vérifié — c'est l'envoi d'essai qui fait foi ici.
   */
  test(
    resolved: ResolvedChannelConfig,
    language: UiLanguage = DEFAULT_UI_LANGUAGE,
  ): Promise<NotificationTestResult> {
    this.target(resolved, language);
    return Promise.resolve({ ok: true, detail: t(language, 'probe.none') });
  }

  async send(resolved: ResolvedChannelConfig, message: NotificationMessage): Promise<void> {
    await httpCall({
      language: message.language,
      channel: this.kind,
      fetch: this.fetchImpl,
      url: this.target(resolved, message.language),
      method: 'POST',
      timeoutMs: this.timeoutMs,
      secrets: resolved.secrets,
      headers: this.headers(resolved, {
        event: message.event,
        severity: message.severity,
        digest: false,
      }),
      body: { version: PAYLOAD_VERSION, type: 'event', ...message },
    });
  }

  /**
   * Le résumé, en JSON, **entier**.
   *
   * C'est le seul canal qui ne tronque rien : sa cible est un programme, pas un
   * écran, et un programme qui reçoit « et 42 autres » ne peut rien en faire. Il
   * reçoit donc `items` au complet (dans la limite de stockage) et `omitted`,
   * qui dit combien de lignes n'ont jamais été retenues — la seule perte qui
   * existe réellement, et elle est nommée.
   */
  async sendDigest(resolved: ResolvedChannelConfig, digest: NotificationDigest): Promise<void> {
    await httpCall({
      language: digest.language,
      channel: this.kind,
      fetch: this.fetchImpl,
      url: this.target(resolved, digest.language),
      method: 'POST',
      timeoutMs: this.timeoutMs,
      secrets: resolved.secrets,
      headers: this.headers(resolved, {
        event: digest.event,
        severity: digest.severity,
        digest: true,
      }),
      body: {
        version: PAYLOAD_VERSION,
        ...digest,
        omitted: notificationDigestOmitted(digest),
      },
    });
  }
}
