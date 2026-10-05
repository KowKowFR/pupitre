import type { RouteCertificate } from './model.js';

/**
 * When a certificate's expiry becomes an alert.
 *
 * Let's Encrypt renews thirty days before expiry, and the proxy then retries
 * every day. A certificate that enters its last fourteen days has therefore
 * missed two weeks of renewals: something is blocking, and there is still time
 * to fix it.
 */
export const CERTIFICATE_WARN_DAYS = 14;

const DAY_MS = 86_400_000;

export type CertificateTransition =
  | { kind: 'expiring'; notAfter: string; daysLeft: number }
  | { kind: 'renewed'; notAfter: string }
  | null;

/**
 * What a probe learns about a certificate, with regard to the expiry already
 * reported for the route (`alerted`, or `null`).
 *
 *   - **one alert per certificate**: a certificate that enters the window is
 *     reported once; the next one, if it enters in turn, will be too — it is
 *     another certificate;
 *   - **its counterpart**: a reported certificate, replaced by another outside
 *     the window, is announced renewed;
 *   - a probe **without a certificate** says nothing: it does not erase what was
 *     reported, otherwise a passing failure would start the alert again.
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
