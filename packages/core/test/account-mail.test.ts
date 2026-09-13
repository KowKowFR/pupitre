import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  accountMailSchema,
  renderAccountMail,
  type AccountMail,
} from '../src/notifications/account-mail.js';

/**
 * Les e-mails du cycle de vie des comptes.
 *
 * Ce que ces tests couvrent et que `verify-invitations.sh` ne peut pas couvrir
 * aussi finement : l'échappement, et le fait que les deux parties du message
 * disent la même chose. Le script, lui, prouve qu'un vrai serveur SMTP les
 * reçoit — les deux sont nécessaires.
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

describe('e-mails de cycle de vie des comptes', () => {
  it('rend toujours deux parties, et la partie texte ne porte aucune balise', () => {
    for (const kind of ['invitation', 'password_reset'] as const) {
      const { subject, text, html } = renderAccountMail(mail({ kind }), 'fr');

      assert.ok(subject.length > 0, `sujet vide pour ${kind}`);
      assert.ok(text.length > 0, `texte vide pour ${kind}`);
      assert.ok(html.length > 0, `HTML vide pour ${kind}`);

      // La règle que `smtp.ts` impose déjà aux alertes : la partie `text/plain`
      // est lue telle quelle par un client en mode texte. Une balise qui s'y
      // glisse est du bruit affiché à l'utilisateur.
      assert.doesNotMatch(text, /<[a-zA-Z/!]/, `du HTML a fui dans la partie texte de ${kind}`);
      assert.match(html, /^<!doctype html>/i);
    }
  });

  it('met le lien dans les deux parties, à l’identique', () => {
    const source = mail();
    const { text, html } = renderAccountMail(source, 'fr');

    assert.ok(text.includes(source.url), 'le lien manque à la partie texte');
    assert.ok(html.includes(source.url), 'le lien manque à la partie HTML');
    // Le HTML le porte trois fois : le `href` du bouton, le `href` du repli, et
    // le repli affiché en clair. Un bouton qui ne se rend pas — c'est le cas
    // dans plusieurs clients d'entreprise — ne doit pas laisser la personne
    // sans rien à copier.
    assert.equal(html.split(source.url).length - 1, 3);
  });

  it('échappe ce qui vient du formulaire', () => {
    const { text, html } = renderAccountMail(
      mail({ recipientName: '<script>alert(1)</script>', instance: 'A & B <prod>' }),
      'fr',
    );

    assert.ok(html.includes('&lt;script&gt;'), 'le nom n’est pas échappé dans le HTML');
    assert.ok(!html.includes('<script>'), 'une balise brute a survécu');
    assert.ok(html.includes('A &amp; B &lt;prod&gt;'), 'le nom d’instance n’est pas échappé');
    // La partie texte, elle, n'échappe rien — c'est du texte. On vérifie
    // seulement qu'elle porte bien la valeur brute, sans transformation muette.
    assert.ok(text.includes('<script>alert(1)</script>'));
  });

  it('distingue les deux situations dans le sujet et dans le corps', () => {
    const invitation = renderAccountMail(mail({ kind: 'invitation' }), 'fr');
    const reset = renderAccountMail(mail({ kind: 'password_reset' }), 'fr');

    assert.notEqual(invitation.subject, reset.subject);
    assert.match(invitation.text, /a ouvert un accès/);
    assert.match(reset.text, /réinitialisation/i);
    // Une invitation ne parle jamais de « réinitialiser » : la personne n'a
    // jamais eu de mot de passe ici.
    assert.doesNotMatch(invitation.text, /réinitialis/i);
  });

  it('nomme l’auteur de l’invitation quand il est connu, et reste correct sinon', () => {
    assert.match(renderAccountMail(mail({ actor: 'admin@example.test' }), 'fr').text, /admin@example\.test/);
    assert.match(renderAccountMail(mail({ actor: null }), 'fr').text, /Un administrateur/);
  });

  it('annonce une durée lisible, pas un nombre de millisecondes', () => {
    const long = renderAccountMail(mail({ expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString() }), 'fr');
    const short = renderAccountMail(
      mail({ kind: 'password_reset', expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
      'fr',
    );

    assert.match(long.text, /valable 3 jours/);
    assert.match(short.text, /valable 1 heure/);
    // Et l'échéance absolue, parce qu'une durée relative lue le lendemain ment.
    assert.match(long.text, /expire le \d{2}\/\d{2}\/\d{4} à \d{2} h \d{2} UTC/);
  });

  it('dit dans les deux cas que le lien ne sert qu’une fois', () => {
    for (const kind of ['invitation', 'password_reset'] as const) {
      const { text, html } = renderAccountMail(mail({ kind }), 'fr');
      assert.match(text, /une seule fois/);
      assert.match(html, /une seule fois/);
    }
  });

  /**
   * L'e-mail part vers quelqu'un qui n'a pas encore de compte, donc pas de
   * préférence : c'est la langue de l'instance qui décide, et elle descend en
   * paramètre parce que `packages/core` ne lit pas la base. Ce test vérifie que
   * le paramètre traverse bien les trois rendus — sujet, texte et HTML — et que
   * le `lang` du document suit, faute de quoi un lecteur d'écran anglophone se
   * ferait lire du français avec une prosodie française.
   */
  it('compose dans la langue qu’on lui donne, jusqu’au `lang` du document', () => {
    const fr = renderAccountMail(mail({ kind: 'invitation' }), 'fr');
    const en = renderAccountMail(mail({ kind: 'invitation' }), 'en');

    assert.notEqual(fr.subject, en.subject);
    assert.match(en.subject, /Your access to/i);
    assert.match(en.text, /Choose my password/);
    assert.ok(!/Choisir mon mot de passe/.test(en.text), 'du français a survécu dans la version anglaise');
    assert.match(fr.html, /<html lang="fr"/);
    assert.match(en.html, /<html lang="en"/);
  });

  it('refuse une adresse ou une URL qui n’en sont pas', () => {
    assert.throws(() => mail({ url: 'pas-une-url' as string }));
    assert.throws(() => accountMailSchema.parse({ ...mail(), kind: 'autre-chose' }));
  });
});
