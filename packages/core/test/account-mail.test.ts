import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  accountMailSchema,
  renderAccountMail,
  type AccountMail,
} from '../src/notifications/account-mail.js';

/**
 * The accounts' life-cycle emails.
 *
 * What these tests cover and `verify-invitations.sh` cannot cover as finely:
 * escaping, and the fact that both parts of the message say the same thing. The
 * script proves that a real SMTP server receives them — both are necessary.
 */

function mail(overrides: Partial<AccountMail> = {}): AccountMail {
  return accountMailSchema.parse({
    kind: 'invitation',
    to: 'alice@example.test',
    recipientName: 'Alice',
    instance: 'Pupitre',
    url: 'https://panel.example.test/api/auth/reset-password/JETON?callbackURL=%2Finvitation',
    expiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    actor: 'admin@example.test',
    ...overrides,
  });
}

describe('account life-cycle emails', () => {
  it('attaches the Pupitre tile and cites it by cid:, without any remote image', () => {
    for (const kind of ['invitation', 'password_reset'] as const) {
      const { html, inlineImages } = renderAccountMail(mail({ kind }), 'fr');
      assert.equal(inlineImages.length, 1);
      const [mark] = inlineImages;
      assert.equal(mark!.contentType, 'image/png');
      // A PNG's eight signature bytes: the attached image is indeed one.
      const bytes = Buffer.from(mark!.content, 'base64');
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.ok(html.includes(`src="cid:${mark!.cid}"`), `tile missing from the HTML for ${kind}`);
      assert.ok(!/<img[^>]+src="https?:/.test(html), 'a remote image slipped in');
    }
  });

  it('always renders two parts, and the text part carries no tag', () => {
    for (const kind of ['invitation', 'password_reset'] as const) {
      const { subject, text, html } = renderAccountMail(mail({ kind }), 'fr');

      assert.ok(subject.length > 0, `empty subject for ${kind}`);
      assert.ok(text.length > 0, `empty text for ${kind}`);
      assert.ok(html.length > 0, `empty HTML for ${kind}`);

      // The rule `smtp.ts` already imposes on alerts: the `text/plain` part is read
      // as is by a text-mode client. A tag that slips in is noise shown to the user.
      assert.doesNotMatch(text, /<[a-zA-Z/!]/, `HTML leaked into the text part of ${kind}`);
      assert.match(html, /^<!doctype html>/i);
    }
  });

  it('puts the link in both parts, identically', () => {
    const source = mail();
    const { text, html } = renderAccountMail(source, 'fr');

    assert.ok(text.includes(source.url), 'the link is missing from the text part');
    assert.ok(html.includes(source.url), 'the link is missing from the HTML part');
    // The HTML carries it three times: the button's `href`, the fallback's `href`,
    // and the fallback shown in clear. A button that does not render — the case in
    // several enterprise clients — must not leave the person with nothing to copy.
    assert.equal(html.split(source.url).length - 1, 3);
  });

  it('escapes what comes from the form', () => {
    const { text, html } = renderAccountMail(
      mail({ recipientName: '<script>alert(1)</script>', instance: 'A & B <prod>' }),
      'fr',
    );

    assert.ok(html.includes('&lt;script&gt;'), 'the name is not escaped in the HTML');
    assert.ok(!html.includes('<script>'), 'a raw tag survived');
    assert.ok(html.includes('A &amp; B &lt;prod&gt;'), 'the instance name is not escaped');
    // The text part escapes nothing — it is text. We only check that it does carry
    // the raw value, without a silent transformation.
    assert.ok(text.includes('<script>alert(1)</script>'));
  });

  it('tells the two situations apart in the subject and in the body', () => {
    const invitation = renderAccountMail(mail({ kind: 'invitation' }), 'fr');
    const reset = renderAccountMail(mail({ kind: 'password_reset' }), 'fr');

    assert.notEqual(invitation.subject, reset.subject);
    assert.match(invitation.text, /a ouvert un accès/);
    assert.match(reset.text, /réinitialisation/i);
    // An invitation never talks about "resetting": the person never had a password
    // here.
    assert.doesNotMatch(invitation.text, /réinitialis/i);
  });

  it('names the invitation’s author when known, and stays correct otherwise', () => {
    assert.match(renderAccountMail(mail({ actor: 'admin@example.test' }), 'fr').text, /admin@example\.test/);
    assert.match(renderAccountMail(mail({ actor: null }), 'fr').text, /Un administrateur/);
  });

  it('announces a readable duration, not a number of milliseconds', () => {
    const long = renderAccountMail(mail({ expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString() }), 'fr');
    const short = renderAccountMail(
      mail({ kind: 'password_reset', expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
      'fr',
    );

    assert.match(long.text, /valable 3 jours/);
    assert.match(short.text, /valable 1 heure/);
    // And the absolute expiry, because a relative duration read the next day lies.
    assert.match(long.text, /expire le \d{2}\/\d{2}\/\d{4} à \d{2} h \d{2} UTC/);
  });

  it('says in both cases that the link only works once', () => {
    for (const kind of ['invitation', 'password_reset'] as const) {
      const { text, html } = renderAccountMail(mail({ kind }), 'fr');
      assert.match(text, /une seule fois/);
      assert.match(html, /une seule fois/);
    }
  });

  /**
   * The email goes to someone who has no account yet, hence no preference: it is
   * the instance's language that decides, and it comes down as a parameter
   * because `packages/core` does not read the database. This test checks that the
   * parameter does go through the three renderings — subject, text and HTML — and
   * that the document's `lang` follows, otherwise an English-speaking screen
   * reader would read French with a French prosody.
   */
  it('composes in the language it is given, down to the document’s `lang`', () => {
    const fr = renderAccountMail(mail({ kind: 'invitation' }), 'fr');
    const en = renderAccountMail(mail({ kind: 'invitation' }), 'en');

    assert.notEqual(fr.subject, en.subject);
    assert.match(en.subject, /Your access to/i);
    assert.match(en.text, /Choose my password/);
    assert.ok(!/Choisir mon mot de passe/.test(en.text), 'French survived in the English version');
    assert.match(fr.html, /<html lang="fr"/);
    assert.match(en.html, /<html lang="en"/);
  });

  it('refuses an address or a URL that are not ones', () => {
    assert.throws(() => mail({ url: 'not-a-url' as string }));
    assert.throws(() => accountMailSchema.parse({ ...mail(), kind: 'autre-chose' }));
  });
});
