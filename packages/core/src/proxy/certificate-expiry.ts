import type { RouteCertificate } from './model.js';

/**
 * Quand l'échéance d'un certificat devient une alerte.
 *
 * Let's Encrypt renouvelle trente jours avant l'échéance, et le proxy retente
 * ensuite chaque jour. Un certificat qui entre dans ses quatorze derniers jours
 * a donc raté deux semaines de renouvellements : quelque chose bloque, et il
 * reste le temps de le régler.
 */
export const CERTIFICATE_WARN_DAYS = 14;

const DAY_MS = 86_400_000;

export type CertificateTransition =
  | { kind: 'expiring'; notAfter: string; daysLeft: number }
  | { kind: 'renewed'; notAfter: string }
  | null;

/**
 * Ce qu'une sonde apprend d'un certificat, au regard de l'échéance déjà
 * signalée pour la route (`alerted`, ou `null`).
 *
 *   - **une alerte par certificat** : un certificat qui entre dans la fenêtre
 *     est signalé une fois ; le suivant, s'il y entre à son tour, le sera
 *     aussi — c'est un autre certificat ;
 *   - **son pendant** : un certificat signalé, remplacé par un autre hors de
 *     la fenêtre, est annoncé renouvelé ;
 *   - une sonde **sans certificat** ne dit rien : elle n'efface pas ce qui a
 *     été signalé, sans quoi un échec passager ferait repartir l'alerte.
 */
export function certificateTransition(
  alerted: string | null,
  certificate: Pick<RouteCertificate, 'notAfter'> | null,
  now: number = Date.now(),
): CertificateTransition {
  const notAfter = certificate?.notAfter ?? null;
  if (notAfter === null) return null;
  const expiresAt = Date.parse(notAfter);
  if (Number.isNaN(expiresAt)) return null;

  const left = expiresAt - now;
  if (left < CERTIFICATE_WARN_DAYS * DAY_MS) {
    if (alerted === notAfter) return null;
    return { kind: 'expiring', notAfter, daysLeft: Math.max(0, Math.floor(left / DAY_MS)) };
  }
  return alerted === null ? null : { kind: 'renewed', notAfter };
}
