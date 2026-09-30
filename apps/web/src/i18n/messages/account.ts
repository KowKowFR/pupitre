import type { Translated } from '@pupitre/core';

/**
 * L'espace personnel : mot de passe et second facteur, l'écran et les quatre
 * routes qui le servent.
 *
 * Séparé de `auth` parce que les deux surfaces ne s'adressent pas à la même
 * personne : `auth` parle à quelqu'un qui n'est pas encore entré, `account` à
 * quelqu'un qui est connecté et agit sur son propre compte. Les phrases n'ont
 * donc rien à se prêter — et un même mot y prend un sens différent (« Mot de
 * passe » est un champ à l'entrée, une section ici).
 *
 * Les messages d'erreur des routes passent par `msg()` : `apiRoute()` les rend
 * dans la langue de l'instance au moment de sérialiser, et `error.message`
 * reste français pour les logs.
 */
const fr = {
  // ── L'écran ─────────────────────────────────────────────────────────────
  'meta.title': 'Mon compte — Pupitre',
  'page.title': 'Sécurité du compte',
  'crumb': 'Mon compte',
  'page.description':
    "Ce qui protège l'accès au panel : le mot de passe, et un second facteur qui survit à sa fuite. Les deux se gèrent ici, pour soi seul — un administrateur n'a pas le pouvoir d'activer un second facteur à votre place.",

  /**
   * Repli d'un `fetch` du panel dont la réponse ne porte pas de message. Il
   * ressemble à `common.http.failure`, mais il finit par un point : la
   * ponctuation d'origine est reproduite telle quelle, comme partout ailleurs.
   */
  'error.http': 'Échec (HTTP {status}).',

  // ── Mot de passe ────────────────────────────────────────────────────────
  'password.title': 'Mot de passe',
  'password.description':
    "L'ancien mot de passe est exigé : sans lui, un cookie de session volé suffirait à s'emparer du compte. Le changement ferme toutes les autres sessions ouvertes.",
  'password.field.current': 'Mot de passe actuel',
  'password.field.new': 'Nouveau mot de passe',
  'password.field.confirmation': 'Confirmation',
  'password.min': { one: '{count} caractère minimum.', other: '{count} caractères minimum.' },
  'password.tooShort': {
    one: 'Le mot de passe doit faire au moins {count} caractère.',
    other: 'Le mot de passe doit faire au moins {count} caractères.',
  },
  'password.tooShortTyped': '{count} caractères minimum ({typed} saisis).',
  'password.mismatch': 'La confirmation ne correspond pas au nouveau mot de passe.',
  'password.submit': 'Changer le mot de passe',
  'password.pending': 'Changement…',
  'password.changed':
    'Mot de passe changé. Toutes les autres sessions ont été fermées ; celle-ci reste ouverte.',

  // ── Second facteur ──────────────────────────────────────────────────────
  'twoFactor.title': 'Double authentification (TOTP)',
  'twoFactor.badge.on': 'active',
  'twoFactor.badge.off': 'inactive',
  'twoFactor.badge.setup': 'configuration',
  'twoFactor.description':
    "Un code à six chiffres, renouvelé toutes les trente secondes par une application d'authentification. Le QR code est dessiné dans cette page : le secret ne part chez personne.",
  'twoFactor.field.password': 'Mot de passe',
  'twoFactor.enable': 'Activer le second facteur',
  'twoFactor.generating': 'Génération…',
  'twoFactor.enabled': 'Second facteur activé. Il sera demandé à chaque connexion.',
  'twoFactor.armed.body':
    'Chaque connexion réclame un code. Pour retirer ce facteur, confirmez avec votre mot de passe.',
  'twoFactor.disabling': 'Désactivation…',
  'twoFactor.disabled':
    'Second facteur désactivé. La connexion ne demande plus que le mot de passe.',

  // ── L'activation, étape par étape ───────────────────────────────────────
  'setup.scan':
    'Scannez ce code, ou saisissez la clé à la main si votre application ne peut pas lire de QR.',
  'setup.key': 'Clé de configuration',
  'setup.backup.title': 'Codes de secours — affichés une seule fois.',
  'setup.backup.body':
    "Ils ne seront plus jamais montrés. Notez-les hors de cette machine : ce sont les seules clés qui rouvriront le compte si vous perdez votre téléphone. Chacun ne sert qu'une fois.",
  'setup.code.label': "Code affiché par l'application",
  'setup.code.hint': "Le second facteur n'est armé qu'après ce premier code valide.",
  'setup.submit': 'Vérifier et activer',

  /**
   * Les verdicts d'un e-mail transactionnel que l'appelant a choisi d'attendre
   * — l'invitation lancée depuis `/admin/users`. Le texte de l'e-mail lui-même
   * vit dans `@pupitre/core`, à côté de sa composition : c'est le worker qui le
   * rend, et il n'atteindrait pas un dictionnaire du panel.
   */
  'mail.timeout':
    "L'e-mail n'est pas parti dans le délai imparti. Le worker est peut-être saturé — le compte existe, vous pouvez relancer l’invitation.",
  'mail.failed': 'L’e-mail n’est pas parti : {message}',
  'mail.unreadableVerdict': 'Le worker a renvoyé un verdict illisible',

  // ── Erreurs des routes ──────────────────────────────────────────────────
  'error.invalidPassword': 'Le mot de passe actuel est incorrect.',
  'error.passwordTooShort': 'Le nouveau mot de passe est trop court.',
  'error.passwordTooLong': 'Le nouveau mot de passe est trop long.',
  'error.noCredentialAccount': "Ce compte n'a pas de mot de passe local.",
  'error.invalidCode': 'Code invalide. Vérifiez l’horloge de votre téléphone, puis réessayez.',
  'error.totpNotEnabled': "Aucun second facteur n'est en cours de configuration.",
  'error.totpAlreadyEnabled': 'Le second facteur est déjà actif.',
  'error.twoFactorNotEnabled': "Le second facteur n'est pas actif sur ce compte.",
  'error.accountLocked': 'Trop de codes erronés. Réessayez dans quelques minutes.',
  'error.passwordChangeRejected': 'Le changement de mot de passe a été refusé.',
  'error.codeRejected': "Le code n'a pas été accepté.",
  'error.disableRejected': 'La désactivation a été refusée.',
  'error.setupRejected': 'La configuration du second facteur a été refusée.',
  'error.totpUriMissing': "Better Auth n'a pas renvoyé d'URI TOTP.",
} as const;

const en: Translated<typeof fr> = {
  'meta.title': 'My account — Pupitre',
  'page.title': 'Account security',
  'crumb': 'My account',
  'page.description':
    'What protects access to the panel: the password, and a second factor that outlives its leak. You manage both here, for yourself alone — an administrator cannot turn on a second factor in your place.',

  'error.http': 'Failed (HTTP {status}).',

  'password.title': 'Password',
  'password.description':
    'The old password is required: without it, a stolen session cookie would be enough to take over the account. Changing it closes every other open session.',
  'password.field.current': 'Current password',
  'password.field.new': 'New password',
  'password.field.confirmation': 'Confirmation',
  'password.min': { one: '{count} character minimum.', other: '{count} characters minimum.' },
  'password.tooShort': {
    one: 'The password must be at least {count} character long.',
    other: 'The password must be at least {count} characters long.',
  },
  'password.tooShortTyped': '{count} characters minimum ({typed} typed).',
  'password.mismatch': 'The confirmation does not match the new password.',
  'password.submit': 'Change the password',
  'password.pending': 'Changing…',
  'password.changed': 'Password changed. Every other session is closed; this one stays open.',

  'twoFactor.title': 'Two-factor authentication (TOTP)',
  'twoFactor.badge.on': 'on',
  'twoFactor.badge.off': 'off',
  'twoFactor.badge.setup': 'setting up',
  'twoFactor.description':
    'A six-digit code, renewed every thirty seconds by an authenticator app. The QR code is drawn in this page: the secret goes to nobody.',
  'twoFactor.field.password': 'Password',
  'twoFactor.enable': 'Enable the second factor',
  'twoFactor.generating': 'Generating…',
  'twoFactor.enabled': 'Second factor on. It will be asked for at every sign-in.',
  'twoFactor.armed.body':
    'Every sign-in asks for a code. To drop this factor, confirm with your password.',
  'twoFactor.disabling': 'Disabling…',
  'twoFactor.disabled': 'Second factor off. Signing in asks for the password only.',

  'setup.scan': 'Scan this code, or type the key by hand if your app cannot read a QR.',
  'setup.key': 'Setup key',
  'setup.backup.title': 'Recovery codes — shown once.',
  'setup.backup.body':
    'They will never be shown again. Write them down off this machine: they are the only keys that reopen the account if you lose your phone. Each one serves once.',
  'setup.code.label': 'Code shown by the app',
  'setup.code.hint': 'The second factor is armed only after this first valid code.',
  'setup.submit': 'Verify and enable',

  'mail.timeout':
    'The email did not go out in time. The worker may be saturated — the account exists, you can send the invitation again.',
  'mail.failed': 'The email did not go out: {message}',
  'mail.unreadableVerdict': 'The worker returned an unreadable verdict',

  'error.invalidPassword': 'The current password is wrong.',
  'error.passwordTooShort': 'The new password is too short.',
  'error.passwordTooLong': 'The new password is too long.',
  'error.noCredentialAccount': 'This account has no local password.',
  'error.invalidCode': 'Invalid code. Check your phone’s clock, then try again.',
  'error.totpNotEnabled': 'No second factor is being set up.',
  'error.totpAlreadyEnabled': 'The second factor is already on.',
  'error.twoFactorNotEnabled': 'The second factor is not on for this account.',
  'error.accountLocked': 'Too many wrong codes. Try again in a few minutes.',
  'error.passwordChangeRejected': 'The password change was refused.',
  'error.codeRejected': 'The code was not accepted.',
  'error.disableRejected': 'Disabling was refused.',
  'error.setupRejected': 'Setting up the second factor was refused.',
  'error.totpUriMissing': 'Better Auth returned no TOTP URI.',
};

export const account = { fr, en };
