import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CERTIFICATE_WARN_DAYS, certificateTransition } from '../src/proxy/certificate-expiry.js';

/**
 * A certificate's expiry: one alert per certificate when it enters its last
 * days, the announcement of its renewal, and nothing else.
 */

const NOW = Date.parse('2026-10-02T12:00:00Z');
const inDays = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

describe('certificate expiry', () => {
  it('keeps quiet far from expiry', () => {
    assert.equal(certificateTransition(null, { notAfter: inDays(60) }, NOW), null);
    assert.equal(
      certificateTransition(null, { notAfter: inDays(CERTIFICATE_WARN_DAYS + 1) }, NOW),
      null,
    );
  });

  it('warns once when a certificate enters its last fourteen days', () => {
    const notAfter = inDays(9);
    assert.deepEqual(certificateTransition(null, { notAfter }, NOW), {
      kind: 'expiring',
      notAfter,
      daysLeft: 9,
    });
    // The next probe sees the same expiry, already reported: nothing.
    assert.equal(certificateTransition(notAfter, { notAfter }, NOW), null);
  });

  it('another certificate in the window is another report', () => {
    const first = inDays(10);
    const second = inDays(5);
    assert.equal(certificateTransition(first, { notAfter: second }, NOW)?.kind, 'expiring');
  });

  it('an expired certificate stays reported, at zero days', () => {
    const transition = certificateTransition(null, { notAfter: inDays(-2) }, NOW);
    assert.equal(transition?.kind, 'expiring');
    assert.equal(transition?.kind === 'expiring' ? transition.daysLeft : -1, 0);
  });

  it('announces the renewal of a reported certificate', () => {
    const renewed = inDays(89);
    assert.deepEqual(certificateTransition(inDays(9), { notAfter: renewed }, NOW), {
      kind: 'renewed',
      notAfter: renewed,
    });
  });

  it('a probe without a certificate erases nothing and says nothing', () => {
    assert.equal(certificateTransition(inDays(9), null, NOW), null);
    assert.equal(certificateTransition(inDays(9), { notAfter: null }, NOW), null);
    assert.equal(certificateTransition(null, { notAfter: 'not a date' }, NOW), null);
  });
});
