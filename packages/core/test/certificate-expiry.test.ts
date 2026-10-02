import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CERTIFICATE_WARN_DAYS, certificateTransition } from '../src/proxy/certificate-expiry.js';

/**
 * L'échéance d'un certificat : une alerte par certificat quand il entre dans
 * ses derniers jours, l'annonce de son renouvellement, et rien d'autre.
 */

const NOW = Date.parse('2026-10-02T12:00:00Z');
const inDays = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

describe('échéance des certificats', () => {
  it('se tait loin de l’échéance', () => {
    assert.equal(certificateTransition(null, { notAfter: inDays(60) }, NOW), null);
    assert.equal(
      certificateTransition(null, { notAfter: inDays(CERTIFICATE_WARN_DAYS + 1) }, NOW),
      null,
    );
  });

  it('prévient une fois quand un certificat entre dans ses quatorze derniers jours', () => {
    const notAfter = inDays(9);
    assert.deepEqual(certificateTransition(null, { notAfter }, NOW), {
      kind: 'expiring',
      notAfter,
      daysLeft: 9,
    });
    // La sonde suivante voit la même échéance, déjà signalée : rien.
    assert.equal(certificateTransition(notAfter, { notAfter }, NOW), null);
  });

  it('un autre certificat dans la fenêtre est un autre signalement', () => {
    const first = inDays(10);
    const second = inDays(5);
    assert.equal(certificateTransition(first, { notAfter: second }, NOW)?.kind, 'expiring');
  });

  it('un certificat échu reste signalé, à zéro jour', () => {
    const transition = certificateTransition(null, { notAfter: inDays(-2) }, NOW);
    assert.equal(transition?.kind, 'expiring');
    assert.equal(transition?.kind === 'expiring' ? transition.daysLeft : -1, 0);
  });

  it('annonce le renouvellement d’un certificat signalé', () => {
    const renewed = inDays(89);
    assert.deepEqual(certificateTransition(inDays(9), { notAfter: renewed }, NOW), {
      kind: 'renewed',
      notAfter: renewed,
    });
  });

  it('une sonde sans certificat n’efface rien et ne dit rien', () => {
    assert.equal(certificateTransition(inDays(9), null, NOW), null);
    assert.equal(certificateTransition(inDays(9), { notAfter: null }, NOW), null);
    assert.equal(certificateTransition(null, { notAfter: 'pas une date' }, NOW), null);
  });
});
