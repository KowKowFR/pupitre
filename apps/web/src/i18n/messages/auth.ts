import type { Translated } from '@pupitre/core';

/**
 * Les écrans qu'on voit **avant** d'entrer, et ceux qu'on voit **quand ça
 * rate** : connexion, inscription, mot de passe oublié, invitation,
 * déconnexion, accès refusé, 404 et filets d'erreur.
 *
 * Une seule surface pour les deux, parce qu'elles partagent le même
 * vocabulaire de sortie de secours — « Retour à la connexion », « Retour au
 * tableau de bord », « Réessayer » — et qu'un visiteur passe de l'une à l'autre
 * sans s'en apercevoir.
 *
 * Rappel de la règle : la colonne `fr` reproduit à l'identique les chaînes qui
 * existaient. `verify-invitations.sh` cherche « Mot de passe oubli » et
 * « Réinitialisation indisponible » dans le HTML servi ; une apostrophe
 * redressée le ferait échouer. Les `&apos;` du JSX sont donc écrits ici en
 * apostrophe droite, qui est exactement ce que le navigateur rendait.
 */
const fr = {
  // ── Le cadre de l'écran d'entrée ────────────────────────────────────────
  'shell.tagline': 'Plan de contrôle de déploiement',
  'shell.footer.line1': "Panel auto-hébergé. Les déploiements partent d'ici vers vos machines,",
  'shell.footer.line2': 'en Docker Compose ou en K3s.',

  // ── Titres d'onglet ─────────────────────────────────────────────────────
  'meta.login': 'Connexion — Pupitre',
  'meta.signup': 'Inscription — Pupitre',
  'meta.forgot': 'Mot de passe oublié — Pupitre',
  'meta.reset': 'Nouveau mot de passe — Pupitre',
  'meta.invitation': 'Invitation — Pupitre',
  'meta.logout': 'Déconnexion — Pupitre',

  // ── Champs, partagés par les quatre formulaires ─────────────────────────
  'field.name': 'Nom',
  'field.email': 'Adresse e-mail',
  'field.password': 'Mot de passe',
  'field.confirmation': 'Confirmation',
  'field.password.show': 'Afficher',
  'field.password.hide': 'Masquer',

  /**
   * La longueur minimale est une constante (`PASSWORD_MIN_LENGTH`), pas une
   * variable d'exécution — mais elle passe quand même par `{count}` : c'est ce
   * qui permet de la changer sans retoucher deux traductions, et de laisser
   * `Intl.PluralRules` trancher si elle tombait un jour à 1.
   */
  'password.min': { one: '{count} caractère minimum.', other: '{count} caractères minimum.' },
  'password.tooShort': {
    one: 'Le mot de passe doit faire au moins {count} caractère.',
    other: 'Le mot de passe doit faire au moins {count} caractères.',
  },

  // ── Sorties de secours ──────────────────────────────────────────────────
  'link.backToLogin': 'Retour à la connexion',
  'link.backToDashboard': "Retour à la vue d'ensemble",
  'link.back': 'Retour',

  // ── Connexion ───────────────────────────────────────────────────────────
  'login.title': 'Connexion',
  'login.description': "Avec l'adresse et le mot de passe de votre compte.",
  'login.submit': 'Se connecter',
  'login.pending': 'Connexion…',
  /** Volontairement générique : ne pas révéler si le compte existe. */
  'login.rejected': 'Identifiants invalides.',
  'login.forgot': 'Mot de passe oublié ?',
  'login.signup.prompt': 'Pas de compte ?',
  'login.signup.link': 'En créer un',
  'login.signup.note': ". Le premier compte de l'instance reçoit le rôle administrateur.",
  'login.signup.closed':
    "L'inscription est fermée sur cette instance : les comptes sont créés par un administrateur, depuis « Utilisateurs ».",

  // ── Second facteur, au moment de la connexion ───────────────────────────
  'twoFactor.title': 'Second facteur',
  'twoFactor.description.totp':
    "Saisissez le code à six chiffres affiché par votre application d'authentification.",
  'twoFactor.description.backup':
    'Saisissez un code de secours. Chacun ne fonctionne qu’une seule fois.',
  'twoFactor.field.code': 'Code',
  'twoFactor.field.backupCode': 'Code de secours',
  'twoFactor.submit': 'Valider',
  'twoFactor.clock':
    "Le code change toutes les 30 s. S'il est refusé, vérifiez l'horloge de votre téléphone.",
  'twoFactor.sixth': "Le bouton s'active au 6ᵉ chiffre.",
  'twoFactor.error.backup': 'Code de secours invalide ou déjà utilisé.',
  'twoFactor.error.totp': "Code invalide. Vérifiez l'horloge de votre téléphone, puis réessayez.",
  'twoFactor.useApp': 'Utiliser le code de mon application',
  'twoFactor.useBackup': 'Utiliser un code de secours',

  // ── Inscription ─────────────────────────────────────────────────────────
  'signup.title': 'Créer un compte',
  'signup.description': 'Le premier compte créé reçoit automatiquement le rôle administrateur.',
  'signup.submit': 'Créer le compte',
  'signup.failed': "L'inscription a échoué.",
  'signup.haveAccount': 'Déjà un compte ?',
  'signup.closed.title': 'Inscription fermée',
  'signup.closed.description': "L'inscription publique est désactivée sur cette instance.",
  'signup.closed.hint': 'Demandez un compte à un administrateur, ou activez',
  /** Renvoyée par l'API quand `ALLOW_SIGNUP` est faux et qu'un compte existe. */
  'signup.closed.api':
    "L'inscription publique est désactivée. Demandez un compte à un administrateur.",

  // ── Mot de passe oublié ─────────────────────────────────────────────────
  'forgot.title': 'Mot de passe oublié',
  'forgot.description':
    "Saisissez l'adresse de votre compte. Un lien pour en choisir un nouveau vous y sera envoyé.",
  'forgot.submit': 'Envoyer le lien',
  'forgot.pending': 'Envoi…',
  'forgot.sent.title': 'Vérifiez votre boîte de réception',
  'forgot.sent.description':
    "Si un compte existe pour cette adresse, un lien vient d'y être envoyé.",
  'forgot.sent.notice':
    "Le lien ne fonctionne qu'une seule fois et expire au bout d'une heure. Choisir un nouveau mot de passe fermera toutes les sessions ouvertes sur le compte.",
  'forgot.throttled':
    'Trop de demandes depuis cette adresse IP. Attendez une minute avant de réessayer.',
  'forgot.unavailable.title': 'Réinitialisation indisponible',
  'forgot.unavailable.description':
    "Cette instance n'a aucun canal e-mail configuré : elle ne peut envoyer aucun lien.",
  'forgot.unavailable.hint.before':
    'Demandez à un administrateur de vous redonner un accès. Il peut configurer un serveur SMTP dans',
  'forgot.unavailable.hint.path': 'Paramètres → Notifications',
  'forgot.unavailable.hint.after': 'pour que ce parcours fonctionne.',

  // ── Choisir un mot de passe à partir d'un lien ──────────────────────────
  'choose.mismatch': 'Les deux mots de passe ne sont pas identiques.',
  'choose.noToken': 'Ce lien ne porte aucun jeton.',
  'choose.throttled': 'Trop de tentatives. Attendez une minute avant de réessayer.',
  'choose.rejected': 'Le mot de passe a été refusé. Réessayez, ou demandez un nouveau lien.',
  'choose.dead.notice':
    "Un lien ne fonctionne qu'une seule fois, et il expire. Celui-ci a été utilisé, ou son délai est passé.",
  'choose.newLink': 'Demander un nouveau lien',

  // ── Réinitialisation : les mots de l'écran `/reset-password` ────────────
  'reset.title': 'Nouveau mot de passe',
  'reset.description':
    'Choisissez un mot de passe. Toutes les sessions ouvertes sur ce compte seront fermées, y compris celles que vous n’avez pas ouvertes.',
  'reset.submit': 'Enregistrer et fermer les sessions',
  'reset.done.title': 'Mot de passe changé',
  'reset.done.body':
    'Les sessions ouvertes sur ce compte ont été fermées. Reconnectez-vous avec votre nouveau mot de passe.',
  'reset.dead.title': 'Lien de réinitialisation périmé',
  'reset.dead.body': 'Ce lien ne permet plus de changer de mot de passe.',

  // ── Invitation : même mécanisme, autre situation ────────────────────────
  'invitation.title': 'Choisissez votre mot de passe',
  'invitation.description':
    'Votre compte est prêt. Il ne lui manque qu’un mot de passe — vous seul le connaîtrez.',
  'invitation.submit': 'Activer mon compte',
  'invitation.done.title': 'Compte activé',
  'invitation.done.body':
    'Votre mot de passe est enregistré. Connectez-vous pour entrer dans le panel.',
  'invitation.dead.title': 'Invitation périmée',
  'invitation.dead.body': 'Ce lien d’invitation a déjà servi, ou son délai est passé.',

  // ── Déconnexion ─────────────────────────────────────────────────────────
  'logout.pending': 'Déconnexion…',

  // ── Accès refusé ────────────────────────────────────────────────────────
  'forbidden.title': 'Accès refusé',
  'forbidden.description': "Votre rôle ne permet pas d'ouvrir cette page.",
  'forbidden.permission': 'Permission requise :',
  'forbidden.body':
    "Les permissions se portent par le rôle, jamais par le compte : un administrateur l'ajoute au vôtre depuis Administration → Rôles, et elle prend effet à votre prochaine navigation. La tentative est enregistrée dans les logs d'activité, au même titre qu'une action aboutie.",

  // ── 404 hors du panel ───────────────────────────────────────────────────
  'notFound.title': "Cette page n'existe pas",
  'notFound.description': "L'adresse demandée ne correspond à aucun écran du panel.",
  'notFound.body':
    "Elle a pu être renommée, ou l'objet qu'elle désignait — un déploiement, une cible — a pu être supprimé depuis que le lien a été copié.",

  // ── 404 dans le panel, rail de navigation conservé ──────────────────────
  'appNotFound.eyebrow': 'Introuvable',
  'appNotFound.title': 'Rien à cette adresse',
  'appNotFound.description': "L'objet demandé n'existe pas, ou plus.",
  'appNotFound.body':
    'Un déploiement purgé, une application supprimée ou une cible retirée laissent leurs liens derrière eux. Le rail de navigation à gauche reste utilisable.',

  // ── Filet de rendu d'un écran ───────────────────────────────────────────
  'appError.eyebrow': 'Incident',
  'appError.title': "Cet écran n'a pas pu s'afficher",
  'appError.description': 'Le rail reste utilisable ; seule cette page a échoué.',
  'appError.fallback': 'Erreur inattendue pendant le rendu de la page.',
  'appError.digest.before': 'Référence à citer dans un rapport :',
  'appError.digest.after': '— elle se retrouve dans les logs du serveur.',

  // ── Dernier filet : le layout racine lui-même a échoué ──────────────────
  'globalError.title': "Le panel n'a pas pu démarrer",
  'globalError.body':
    "L'erreur s'est produite avant l'affichage de l'interface. Vérifiez que PostgreSQL et Redis répondent, puis réessayez.",
  'globalError.reference': 'Référence :',
} as const;

const en: Translated<typeof fr> = {
  'shell.tagline': 'Deployment control plane',
  'shell.footer.line1': 'Self-hosted panel. Deployments leave from here to your machines,',
  'shell.footer.line2': 'on Docker Compose or on K3s.',

  'meta.login': 'Sign in — Pupitre',
  'meta.signup': 'Sign up — Pupitre',
  'meta.forgot': 'Forgotten password — Pupitre',
  'meta.reset': 'New password — Pupitre',
  'meta.invitation': 'Invitation — Pupitre',
  'meta.logout': 'Signing out — Pupitre',

  'field.name': 'Name',
  'field.email': 'Email address',
  'field.password': 'Password',
  'field.confirmation': 'Confirmation',
  'field.password.show': 'Show',
  'field.password.hide': 'Hide',

  'password.min': { one: '{count} character minimum.', other: '{count} characters minimum.' },
  'password.tooShort': {
    one: 'The password must be at least {count} character long.',
    other: 'The password must be at least {count} characters long.',
  },

  'link.backToLogin': 'Back to sign-in',
  'link.backToDashboard': 'Back to the overview',
  'link.back': 'Back',

  'login.title': 'Sign in',
  'login.description': 'With the address and password of your account.',
  'login.submit': 'Sign in',
  'login.pending': 'Signing in…',
  'login.rejected': 'Invalid credentials.',
  'login.forgot': 'Forgotten password?',
  'login.signup.prompt': 'No account?',
  'login.signup.link': 'Create one',
  'login.signup.note': '. The first account on the instance gets the admin role.',
  'login.signup.closed':
    'Signing up is closed on this instance: accounts are created by an administrator, from “Users”.',

  'twoFactor.title': 'Second factor',
  'twoFactor.description.totp': 'Enter the six-digit code shown by your authenticator app.',
  'twoFactor.description.backup': 'Enter a recovery code. Each one works only once.',
  'twoFactor.field.code': 'Code',
  'twoFactor.field.backupCode': 'Recovery code',
  'twoFactor.submit': 'Verify',
  'twoFactor.clock':
    'The code changes every 30 s. If it is refused, check the clock of your phone.',
  'twoFactor.sixth': 'The button unlocks at the 6th digit.',
  'twoFactor.error.backup': 'Recovery code invalid, or already used.',
  'twoFactor.error.totp': 'Invalid code. Check your phone’s clock, then try again.',
  'twoFactor.useApp': 'Use my app’s code',
  'twoFactor.useBackup': 'Use a recovery code',

  'signup.title': 'Create an account',
  'signup.description': 'The first account created gets the admin role automatically.',
  'signup.submit': 'Create the account',
  'signup.failed': 'Signing up failed.',
  'signup.haveAccount': 'Already have an account?',
  'signup.closed.title': 'Signing up is closed',
  'signup.closed.description': 'Public sign-up is off on this instance.',
  'signup.closed.hint': 'Ask an administrator for an account, or set',
  'signup.closed.api': 'Public sign-up is off. Ask an administrator for an account.',

  'forgot.title': 'Forgotten password',
  'forgot.description':
    'Enter your account address. A link to choose a new password will be sent there.',
  'forgot.submit': 'Send the link',
  'forgot.pending': 'Sending…',
  'forgot.sent.title': 'Check your inbox',
  'forgot.sent.description': 'If an account exists for this address, a link has just gone out.',
  'forgot.sent.notice':
    'The link works once and expires after an hour. Choosing a new password closes every session open on the account.',
  'forgot.throttled': 'Too many requests from this IP address. Wait a minute before trying again.',
  'forgot.unavailable.title': 'Reset unavailable',
  'forgot.unavailable.description':
    'This instance has no email channel configured: it cannot send any link.',
  'forgot.unavailable.hint.before':
    'Ask an administrator to restore your access. They can configure an SMTP server under',
  'forgot.unavailable.hint.path': 'Settings → Notifications',
  'forgot.unavailable.hint.after': 'to make this path work.',

  'choose.mismatch': 'The two passwords are not the same.',
  'choose.noToken': 'This link carries no token.',
  'choose.throttled': 'Too many attempts. Wait a minute before trying again.',
  'choose.rejected': 'The password was refused. Try again, or ask for a new link.',
  'choose.dead.notice':
    'A link works once, and it expires. This one has been used, or its deadline has passed.',
  'choose.newLink': 'Ask for a new link',

  'reset.title': 'New password',
  'reset.description':
    'Choose a password. Every session open on this account will be closed, including the ones you did not open.',
  'reset.submit': 'Save and close the sessions',
  'reset.done.title': 'Password changed',
  'reset.done.body':
    'Every session open on this account has been closed. Sign in again with your new password.',
  'reset.dead.title': 'Reset link expired',
  'reset.dead.body': 'This link can no longer change a password.',

  'invitation.title': 'Choose your password',
  'invitation.description':
    'Your account is ready. All it lacks is a password — and you alone will know it.',
  'invitation.submit': 'Activate my account',
  'invitation.done.title': 'Account activated',
  'invitation.done.body': 'Your password is saved. Sign in to enter the panel.',
  'invitation.dead.title': 'Invitation expired',
  'invitation.dead.body': 'This invitation link has already been used, or its deadline has passed.',

  'logout.pending': 'Signing out…',

  'forbidden.title': 'Access denied',
  'forbidden.description': 'Your role does not open this page.',
  'forbidden.permission': 'Permission required:',
  'forbidden.body':
    'Permissions are carried by the role, never by the account: an administrator adds this one to yours under Administration → Roles, and it takes effect on your next navigation. The attempt is recorded in the activity log, just like an action that succeeds.',

  'notFound.title': 'This page does not exist',
  'notFound.description': 'The address you asked for matches no screen of the panel.',
  'notFound.body':
    'It may have been renamed, or the object it named — a deployment, a target — may have been deleted since the link was copied.',

  'appNotFound.eyebrow': 'Not found',
  'appNotFound.title': 'Nothing at this address',
  'appNotFound.description': 'The object you asked for does not exist, or no longer does.',
  'appNotFound.body':
    'A purged deployment, a deleted app or a removed target leave their links behind. The navigation rail on the left still works.',

  'appError.eyebrow': 'Incident',
  'appError.title': 'This screen could not be drawn',
  'appError.description': 'The rest of the panel keeps working.',
  'appError.fallback': 'Unexpected error while rendering the page.',
  'appError.digest.before': 'Reference to quote in a report:',
  'appError.digest.after': '— it is in the server logs too.',

  'globalError.title': 'The panel could not start',
  'globalError.body':
    'The error happened before the interface was drawn. Check that PostgreSQL and Redis answer, then try again.',
  'globalError.reference': 'Reference:',
};

export const auth = { fr, en };
