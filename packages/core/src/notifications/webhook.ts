import type { ChannelConfig } from './catalog.js';
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

  private target(resolved: ResolvedChannelConfig): string {
    const url = str(resolved.config, 'url');
    if (url.length === 0) {
      throw new NotificationError('aucune URL configurée', this.kind, 'config');
    }
    return url;
  }

  private headers(resolved: ResolvedChannelConfig, message: NotificationMessage) {
    const token = str(resolved.secrets, 'token');
    return {
      // Deux en-têtes de routage, pour qu'un consommateur puisse trier sans
      // désérialiser le corps — un filtre de passerelle, typiquement.
      'X-Control-Plane-Event': message.event,
      'X-Control-Plane-Severity': message.severity,
      ...(token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  /**
   * Aucune sonde possible : un webhook quelconque n'offre rien d'autre que le
   * POST lui-même, et le sonder reviendrait à livrer. On le dit plutôt que de
   * prétendre avoir vérifié — c'est l'envoi d'essai qui fait foi ici.
   */
  test(resolved: ResolvedChannelConfig): Promise<NotificationTestResult> {
    this.target(resolved);
    return Promise.resolve({
      ok: true,
      detail:
        'Un webhook générique n’offre aucune sonde qui ne soit pas une livraison : ' +
        'seul l’envoi d’essai ci-dessous prouve que la cible répond.',
    });
  }

  async send(resolved: ResolvedChannelConfig, message: NotificationMessage): Promise<void> {
    await httpCall({
      channel: this.kind,
      fetch: this.fetchImpl,
      url: this.target(resolved),
      method: 'POST',
      timeoutMs: this.timeoutMs,
      secrets: resolved.secrets,
      headers: this.headers(resolved, message),
      body: { version: PAYLOAD_VERSION, ...message },
    });
  }
}
