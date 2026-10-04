import type { Translated } from '@pupitre/core';

/**
 * L'administration : utilisateurs, rôles, journal d'activité — et les erreurs
 * des routes qui les servent.
 *
 * ── Ce qui n'est pas ici, et pourquoi ───────────────────────────────────────
 * Le journal d'activité affiche des entrées **passées**. Une entrée ne porte
 * que des données : un nom d'action (`deployment.created`), un type de
 * ressource, un identifiant, une IP, une charge utile JSON. Rien de tout cela
 * n'entre dans ce dictionnaire — traduire à l'écriture figerait la langue de
 * la trace pour toujours, et ces valeurs sont des identifiants machine, pas de
 * la prose. Ce qui se traduit, c'est le décor autour : en-têtes, pagination,
 * état vide, intitulés de filtres.
 *
 * Même coupure pour les rôles : « verrouillé » est un libellé, `admin` est une
 * clé en base. Les libellés des rôles de départ (« Administrateur »,
 * « Opérateur », « Auditeur », « Observateur », « Sans accès ») restent français dans `@pupitre/core` — le
 * seed les **écrit** dans `roles.label`, où on peut ensuite les renommer.
 *
 * Les descriptions de permissions, elles, sont bien des libellés d'écran :
 * elles vivent dans `@pupitre/core` (`permissionDescriptions`) parce que le
 * vocabulaire RBAC y est partagé, et se rendent avec `translator()`.
 */
const fr = {
  // ── Commun aux deux écrans d'administration ─────────────────────────────

  // ═══ Utilisateurs ═══════════════════════════════════════════════════════
  'users.title': 'Utilisateurs',
  'users.description':
    "Un utilisateur porte un rôle ; le rôle porte les permissions. Désactiver un compte coupe ses sessions : il n'est jamais supprimé, pour garder le journal lisible.",

  'users.invite.title': 'Inviter un utilisateur',
  'users.create.title': 'Créer un utilisateur',

  // Coupée en trois : « Paramètres → Notifications » est mis en évidence dans
  // la phrase, et un fragment de JSX ne se range pas dans un dictionnaire.
  'users.noMail.before':
    'Aucun canal e-mail (SMTP) actif : le mot de passe doit être saisi ici, puis transmis hors bande — et vous le connaîtrez. Configurez un serveur SMTP dans',
  'users.noMail.settings': 'Paramètres → Notifications',
  'users.noMail.after':
    "pour inviter par lien à la place, et pour que « mot de passe oublié » fonctionne sur l'écran de connexion.",

  // ── Formulaire de création / invitation ─────────────────────────────────
  'users.form.name': 'Nom',
  'users.form.email': 'E-mail',
  'users.form.password': 'Mot de passe',
  'users.form.role': 'Rôle',
  'users.form.sending': 'Envoi…',
  'users.form.invite': 'Inviter',
  'users.form.create': 'Créer',
  'users.created.notice': 'Utilisateur créé. Transmettez-lui son mot de passe par un canal sûr.',
  'users.invited.notice':
    'Invitation envoyée à {email}. Le lien est valable 72 heures, une seule fois.',
  'users.invited.failed':
    'Le compte de {email} est créé, mais l’invitation n’est pas partie : {reason}. Relancez-la depuis la liste.',
  'users.reason.unknown': 'raison inconnue',

  // ── Table des utilisateurs ──────────────────────────────────────────────
  'users.drawer.invite': "L'invitation part par e-mail dès l'envoi.",
  'users.drawer.create': 'Le compte est créé avec le mot de passe saisi ici.',
  'users.preview.title': 'Ce que reçoit {name}',
  'users.preview.someone': 'la personne invitée',
  'users.preview.subject': 'Objet :',
  'users.preview.subjectText': '{inviter} vous invite sur Pupitre · {instance}',
  'users.preview.body':
    'Un lien à usage unique, valable 72 h, pour choisir son mot de passe. Aucun administrateur ne connaît jamais ce mot de passe.',
  'users.channel.info':
    'Canal e-mail actif ({channel}). Sans canal e-mail, le formulaire demande un mot de passe à transmettre hors bande.',
  'users.form.send': "Envoyer l'invitation",
  'users.footnote':
    'Le dernier administrateur ne peut ni changer de rôle ni être désactivé, et votre propre compte ne se désactive pas d’ici.',
  'users.more': 'Désactiver, annuler le lien',
  'users.role.aria': 'Rôle de {name}',
  'users.2fa.dialog.titleFor': 'Réinitialiser le second facteur de {name} ?',
  'users.column.user': 'Utilisateur',
  'users.column.role': 'Rôle',
  'users.column.twoFactor': 'Second facteur',
  'users.self': '(vous)',

  'users.action.inviteAgain': 'Inviter à nouveau',
  'users.action.resend': 'Relancer',
  'users.action.removeAvatar': 'Retirer la photo de profil',
  'users.action.cancelLink': 'Annuler le lien',
  'users.action.reset2fa': 'Réinitialiser le 2FA',
  'users.action.reactivate': 'Réactiver',

  'users.state.disabled': 'désactivé',
  /**
   * Le motif par défaut d'une désactivation, faute de motif saisi. Il part en
   * base, dans `users.ban_reason` — une colonne de texte libre que remplit
   * d'ordinaire un administrateur, dans la langue qu'il veut. Le repli suit
   * donc la langue de l'instance au moment où il est écrit.
   */
  'users.banReason.default': 'Désactivé par un administrateur',
  'users.state.invited': 'invité',
  'users.state.expired': 'invitation périmée',
  'users.state.expired.title': 'Aucun mot de passe, et plus aucun lien valable',
  'users.state.active': 'actif',
  'users.invitation.validUntil': 'Lien valable jusqu’au {date}',

  'users.2fa.active': 'actif',
  'users.2fa.pending': 'configuration en cours',
  'users.2fa.pending.title': 'Secret généré, jamais confirmé par un code',
  'users.2fa.none': 'aucun',
  'users.2fa.missing': 'exigé, absent',
  'users.2fa.missing.title':
    'Son rôle exige un second facteur : il n’a accès à rien d’autre tant qu’il ne l’a pas activé',

  'users.invitation.revoked': {
    one: 'Invitation de {email} annulée : {count} lien ne fonctionne plus. Le compte reste, sans mot de passe.',
    other:
      'Invitation de {email} annulée : {count} liens ne fonctionnent plus. Le compte reste, sans mot de passe.',
  },
  'users.invitation.resent':
    'Nouvelle invitation envoyée à {email} via « {channel} ». Les liens précédents sont morts.',
  'users.invitation.failed': 'L’invitation de {email} n’est pas partie : {reason}',

  // Quatre morceaux plutôt qu'une phrase à trous : le milieu change de forme
  // selon qu'il y avait des sessions à fermer ou non.
  'users.2fa.notice.head': 'Second facteur de {email} réinitialisé.',
  'users.2fa.notice.closed': {
    one: '{count} session fermée.',
    other: '{count} sessions fermées.',
  },
  'users.2fa.notice.none': 'Aucune session ouverte à fermer.',
  'users.2fa.notice.tail': 'Il se reconnecte avec son seul mot de passe.',

  'users.2fa.dialog.intro': 'Après validation, pour ce compte :',
  'users.2fa.dialog.totp':
    'le secret TOTP est supprimé — l’application d’authentification ne sert plus ;',
  'users.2fa.dialog.backup':
    'les codes de secours déjà émis cessent immédiatement de fonctionner ;',
  'users.2fa.dialog.sessionsSelf': 'vos autres sessions sont fermées ; celle-ci reste ouverte.',
  'users.2fa.dialog.sessionsOther':
    'toutes ses sessions en cours sont fermées, y compris sur un appareil perdu.',
  'users.2fa.dialog.after':
    'la connexion se fait ensuite avec le mot de passe seul, jusqu’à ce que la personne reconfigure un second facteur depuis',
  'users.2fa.dialog.warn':
    'Vérifiez l’identité du demandeur avant de continuer : ce geste retire une protection, et rien ne le défait à distance.',
  'users.2fa.dialog.pending': 'Réinitialisation…',
  'users.2fa.dialog.confirm': 'Réinitialiser le 2FA de {name}',

  // ═══ Rôles ══════════════════════════════════════════════════════════════
  'roles.title': 'Rôles',
  'roles.error.locked':
    'Le rôle « {key} » est verrouillé : il ne peut être ni modifié ni supprimé.',
  'roles.error.inUse': {
    one: '{count} utilisateur porte le rôle « {key} ». Réattribuez-le avant de supprimer le rôle.',
    other: '{count} utilisateurs portent le rôle « {key} ». Réattribuez-les avant de le supprimer.',
  },
  'roles.description.before':
    'Un utilisateur porte un rôle ; le rôle porte les permissions. Le rôle',
  'roles.description.after':
    "est verrouillé : il détient toujours l'intégralité des permissions, pour qu'on ne puisse pas se retirer les droits nécessaires à se les rendre.",

  'roles.new.title': 'Nouveau rôle',
  'roles.new.kind': 'Rôle',
  'roles.new.step.identity': 'Identité',
  'roles.new.step.permissions': 'Permissions',
  'roles.new.progress': 'Étape {step} sur 2',
  'roles.new.next': 'Suivant : les permissions',
  'roles.new.back': 'Retour',
  'roles.new.create': 'Créer le rôle',
  'roles.new.nameMissing': "Donnez au rôle un nom d'au moins deux caractères.",
  'roles.new.keyInvalid': 'La clé ne prend que des minuscules, des chiffres et des tirets.',
  'roles.new.permissions.help':
    "Cochez ce que « {label} » peut faire. Rien n'est coché d'avance : le rôle ne porte que ce que vous lui accordez, et se modifie ensuite depuis son tiroir.",
  'roles.new.help':
    "La clé sert d'identifiant et ne change plus ensuite. Les permissions se choisissent à l'étape suivante, avant la création.",

  // ── Formulaire de création ──────────────────────────────────────────────
  'roles.form.name': 'Nom',
  'roles.form.namePlaceholder': 'Support niveau 1',
  'roles.form.key': 'Clé',
  'roles.form.keyPlaceholder': 'support-niveau-1',
  'roles.form.keyTaken': 'Cette clé est déjà prise.',
  'roles.form.keyHint': 'Définitive. Minuscules et tirets.',
  'roles.form.description': 'Description',
  'roles.form.descriptionPlaceholder': 'Lecture seule et relance des scans',
  'roles.form.submit': 'Créer le rôle',

  // ── Éditeur ─────────────────────────────────────────────────────────────
  'roles.locked': 'verrouillé',
  'roles.noDescription': 'Sans description.',
  'roles.permissionCount': {
    one: '{count} / {total} permission',
    other: '{count} / {total} permissions',
  },
  'roles.userCount': { one: '{count} utilisateur', other: '{count} utilisateurs' },
  'roles.action.collapse': 'Replier',
  'roles.action.view': 'Voir',
  'roles.new.action': 'Nouveau rôle',
  'roles.delete.title': 'Supprimer le rôle « {label} » ?',
  'roles.delete.gone':
    'Le rôle disparaît de la liste des rôles attribuables ; aucun utilisateur ne le porte.',
  'roles.delete.audit': 'La suppression est écrite au journal, avec les permissions qu’il portait.',
  'roles.delete.confirm': 'Supprimer le rôle',
  'roles.deleted': 'Rôle « {label} » supprimé',
  'roles.created': 'Rôle « {label} » créé',
  'roles.delete.aria': 'Supprimer le rôle {label}',
  'roles.delete.inUse': {
    one: 'Porté par {count} utilisateur : réattribuez-le avant de supprimer ce rôle.',
    other: 'Porté par {count} utilisateurs : réattribuez-les avant de supprimer ce rôle.',
  },
  'roles.changes': { one: '{count} modification', other: '{count} modifications' },
  'roles.saved': 'Rôle enregistré.',
  'roles.locked.notice':
    "Ce rôle est verrouillé. Il détient toujours l'intégralité des permissions, y compris celles ajoutées plus tard, et ne peut être ni renommé ni supprimé.",
  'roles.field.label': 'Nom affiché',
  'roles.field.descriptionPlaceholder': 'À quoi sert ce rôle ?',
  'roles.group.checkAll': 'tout cocher',
  'roles.group.uncheckAll': 'tout décocher',
  'roles.selectedCount': {
    one: '{count} / {total} sélectionnée',
    other: '{count} / {total} sélectionnées',
  },
  'roles.noChanges': 'Aucune modification',
  'roles.sensitive': 'sensible',
  'roles.sensitive.help':
    'Permission sensible : quand l’instance l’exige, un rôle qui la porte impose un second facteur.',
  'roles.matrix.legend': 'Légende',
  'roles.matrix.held': 'accordée',
  'roles.matrix.heldSensitive': 'sensible, accordée',
  'roles.matrix.missing': 'non accordée',
  'roles.matrix.family': 'Famille de permissions',
  'roles.matrix.open': '{action} le rôle {label}',
  'roles.matrix.cell': {
    one: '{family} : {count} sur {total}',
    other: '{family} : {count} sur {total}',
  },
  'roles.matrix.total': 'Total',
  'roles.matrix.twoFactor': 'Second facteur',
  'roles.matrix.twoFactor.required': 'exigé',
  'roles.matrix.twoFactor.help.off':
    'L’instance n’exige le second facteur de personne (Paramètres → Comptes et sessions).',
  'roles.matrix.twoFactor.help.sensitive':
    'Exigé de tout rôle qui porte au moins une permission sensible (Paramètres → Comptes et sessions).',
  'roles.matrix.twoFactor.help.all':
    'Exigé de tous les comptes (Paramètres → Comptes et sessions).',

  'logs.title': 'Journal d’activité',
  'logs.description.before':
    'Qui a fait quoi, quand, et depuis quelle IP. Chaque action du panel passe par',
  'logs.description.after':
    "; ce ne sont ni les logs d'un déploiement ni ceux d'une application. Les refus y figurent au même titre que les actions abouties.",
  'logs.summary': {
    one: '{count} entrée · page {page}/{total}',
    other: '{count} entrées · page {page}/{total}',
  },

  'logs.filter.action': 'Action',
  'logs.filter.resourceType': 'Type de ressource',
  'logs.filter.actor': 'Acteur',
  'logs.filter.actor.all': 'Tous',
  'logs.export': 'Exporter .jsonl',
  'logs.filter.from': 'Du',
  'logs.filter.to': 'Au',
  'logs.filter.submit': 'Filtrer',
  'logs.filter.search': 'Rechercher',
  'logs.filter.search.placeholder': 'action, ressource, acteur, IP, contenu…',
  'logs.filter.severity': 'Criticité',
  'logs.filter.remove': 'Retirer le filtre {filter}',
  'logs.column.severity': 'Criticité',
  'logs.severity.low': 'LOW',
  'logs.severity.medium': 'MEDIUM',
  'logs.severity.high': 'HIGH',
  'logs.severity.critical': 'CRITICAL',
  'logs.severity.low.help': 'Routine : connexions, lectures, réussites, retours à la normale.',
  'logs.severity.medium.help':
    'Un changement de configuration ou d’état, un échec ou un refus ordinaire.',
  'logs.severity.high.help':
    'Une panne, un refus qui ressemble à une tentative, ou un geste sur les accès : rôles, comptes, jetons, intégrations.',
  'logs.severity.critical.help':
    'À traiter maintenant : une empreinte SSH qui change, un retour arrière ou une restauration qui échoue.',

  'logs.empty.title': 'Aucune entrée',
  'logs.empty.hint':
    'Aucun événement ne correspond à ces filtres. Élargissez la plage de dates, la criticité, ou effacez la recherche.',

  'logs.column.actor': 'Acteur',
  'logs.column.action': 'Action',
  'logs.column.resource': 'Ressource',
  'logs.column.ip': 'IP',
  'logs.column.agent': 'Agent',
  /** Une action sans acteur : le worker, le scheduler, ou un visiteur non connecté. */
  'logs.anonymous': 'système / anonyme',
  'logs.viaToken': 'par le jeton « {name} »',
  'logs.column.token': 'Jeton d’API',
  'logs.denial': 'refus',
  'logs.row.open': "Ouvrir l'entrée {action}",
  'logs.drawer.kind': 'Entrée du journal',
  'logs.drawer.who': 'Qui, quoi, où',
  'logs.drawer.payload': 'Charge JSON',
  'logs.drawer.none': 'Aucune charge utile pour cette entrée.',
  'logs.drawer.copy': 'Copier le JSON',
  'logs.drawer.copied': 'JSON copié',
  'logs.drawer.filterActor': 'Filtrer sur cet acteur',
  'logs.drawer.filterAction': 'Filtrer sur cette action',
  'logs.timezone': 'Horodatages en {timezone}.',

  // ═══ Erreurs des routes ═════════════════════════════════════════════════
  'error.role.exists': 'Un rôle « {key} » existe déjà',
  'error.role.notFound': 'Rôle « {key} » introuvable',
  'error.role.deleteFailed': "Le rôle « {key} » n'a pas pu être supprimé",

  'error.user.notFound': 'Utilisateur « {id} » introuvable',
  'error.user.emailTaken': 'Un compte existe déjà pour {email}',
  'error.user.deleteSelf': 'Impossible de supprimer son propre compte',
  'error.user.disableSelf': 'Impossible de désactiver son propre compte',
  'error.user.lastAdmin.delete':
    'Impossible de supprimer le dernier administrateur actif de la plateforme',
  'error.user.lastAdmin.disable':
    'Impossible de désactiver le dernier administrateur actif de la plateforme',
  'error.user.lastAdmin.role':
    'Impossible de retirer le dernier administrateur actif de la plateforme',

  'error.mail.missing.create':
    'Aucun canal e-mail (SMTP) actif : l’invitation ne pourrait pas partir. Configurez-en un dans Paramètres → Notifications, ou créez le compte avec un mot de passe.',
  'error.mail.missing.resend':
    'Aucun canal e-mail (SMTP) actif : l’invitation ne pourrait pas partir.',
  'error.user.hasPassword':
    '{email} a déjà choisi son mot de passe. Une réinitialisation se demande depuis l’écran de connexion.',
  'error.user.banned':
    '{email} est désactivé : réactivez le compte avant de relancer l’invitation.',
  'error.invitation.none': 'Aucun lien en cours pour {email}.',
  'error.user.no2fa': "{email} n'a aucun second facteur à réinitialiser.",

  /** Verdicts d'envoi rendus tels quels dans le bandeau de la liste. */
  'mail.notTriggered': 'aucun e-mail déclenché',
  'mail.sendFailed': 'envoi impossible',
} as const;


const en: Translated<typeof fr> = {
  'users.title': 'Users',
  'users.description':
    'A user carries a role; the role carries the permissions. Disabling an account cuts its sessions: it is never deleted, so the log stays readable.',

  'users.invite.title': 'Invite a user',
  'users.create.title': 'Create a user',

  'users.noMail.before':
    'No active email channel (SMTP): the password has to be typed here, then passed out of band — and you will know it. Set up an SMTP server under',
  'users.noMail.settings': 'Settings → Notifications',
  'users.noMail.after':
    'to invite by link instead, and to make “forgot password” work on the sign-in screen.',

  'users.form.name': 'Name',
  'users.form.email': 'Email',
  'users.form.password': 'Password',
  'users.form.role': 'Role',
  'users.form.sending': 'Sending…',
  'users.form.invite': 'Invite',
  'users.form.create': 'Create',
  'users.created.notice': 'User created. Pass them their password over a safe channel.',
  'users.invited.notice': 'Invitation sent to {email}. The link lasts 72 hours, and works once.',
  'users.invited.failed':
    'The account for {email} exists, but the invitation did not go out: {reason}. Send it again from the list.',
  'users.reason.unknown': 'reason unknown',

  'users.drawer.invite': 'The invitation leaves by e-mail as soon as it is sent.',
  'users.drawer.create': 'The account is created with the password typed here.',
  'users.preview.title': 'What {name} receives',
  'users.preview.someone': 'the invitee',
  'users.preview.subject': 'Subject:',
  'users.preview.subjectText': '{inviter} invites you to Pupitre · {instance}',
  'users.preview.body':
    'A single-use link, valid for 72 h, to choose a password. No administrator ever knows that password.',
  'users.channel.info':
    'E-mail channel active ({channel}). Without an e-mail channel, the form asks for a password to hand over out of band.',
  'users.form.send': 'Send the invitation',
  'users.footnote':
    'The last administrator can neither change role nor be disabled, and your own account cannot be disabled from here.',
  'users.more': 'Disable, cancel the link',
  'users.role.aria': 'Role of {name}',
  'users.2fa.dialog.titleFor': 'Reset the second factor of {name}?',
  'users.column.user': 'User',
  'users.column.role': 'Role',
  'users.column.twoFactor': 'Second factor',
  'users.self': '(you)',

  'users.action.inviteAgain': 'Invite again',
  'users.action.resend': 'Send again',
  'users.action.removeAvatar': 'Remove profile picture',
  'users.action.cancelLink': 'Cancel the link',
  'users.action.reset2fa': 'Reset 2FA',
  'users.action.reactivate': 'Re-enable',

  'users.state.disabled': 'disabled',
  'users.banReason.default': 'Disabled by an administrator',
  'users.state.invited': 'invited',
  'users.state.expired': 'invitation expired',
  'users.state.expired.title': 'No password, and no valid link left',
  'users.state.active': 'active',
  'users.invitation.validUntil': 'Link valid until {date}',

  'users.2fa.active': 'active',
  'users.2fa.pending': 'setup under way',
  'users.2fa.pending.title': 'Secret generated, never confirmed by a code',
  'users.2fa.none': 'none',
  'users.2fa.missing': 'required, missing',
  'users.2fa.missing.title':
    'Their role requires a second factor: they can reach nothing else until they turn it on',

  'users.invitation.revoked': {
    one: 'Invitation for {email} canceled: {count} link no longer works. The account stays, with no password.',
    other:
      'Invitation for {email} canceled: {count} links no longer work. The account stays, with no password.',
  },
  'users.invitation.resent':
    'New invitation sent to {email} via “{channel}”. Earlier links are dead.',
  'users.invitation.failed': 'The invitation for {email} did not go out: {reason}',

  'users.2fa.notice.head': 'Second factor of {email} reset.',
  'users.2fa.notice.closed': {
    one: '{count} session closed.',
    other: '{count} sessions closed.',
  },
  'users.2fa.notice.none': 'No open session to close.',
  'users.2fa.notice.tail': 'They sign in again with their password alone.',

  'users.2fa.dialog.intro': 'Once confirmed, for this account:',
  'users.2fa.dialog.totp': 'the TOTP secret is deleted — the authenticator app is of no more use;',
  'users.2fa.dialog.backup': 'backup codes already issued stop working immediately;',
  'users.2fa.dialog.sessionsSelf': 'your other sessions are closed; this one stays open.',
  'users.2fa.dialog.sessionsOther':
    'all of their open sessions are closed, including on a lost device.',
  'users.2fa.dialog.after':
    'signing in then takes the password alone, until they set up a second factor again from',
  'users.2fa.dialog.warn':
    'Check who is asking before you continue: this removes a protection, and nothing undoes it remotely.',
  'users.2fa.dialog.pending': 'Resetting…',
  'users.2fa.dialog.confirm': 'Reset the 2FA of {name}',

  'roles.title': 'Roles',
  'roles.error.locked': 'Role “{key}” is locked: it can be neither changed nor deleted.',
  'roles.error.inUse': {
    one: '{count} user has role “{key}”. Reassign them before deleting the role.',
    other: '{count} users have role “{key}”. Reassign them before deleting it.',
  },
  'roles.description.before': 'A user carries a role; the role carries the permissions. The role',
  'roles.description.after':
    'is locked: it always holds every permission, so nobody can drop the rights needed to grant them back.',

  'roles.new.title': 'New role',
  'roles.new.kind': 'Role',
  'roles.new.step.identity': 'Identity',
  'roles.new.step.permissions': 'Permissions',
  'roles.new.progress': 'Step {step} of 2',
  'roles.new.next': 'Next: permissions',
  'roles.new.back': 'Back',
  'roles.new.create': 'Create the role',
  'roles.new.nameMissing': 'Give the role a name of at least two characters.',
  'roles.new.keyInvalid': 'The key takes only lowercase letters, digits and hyphens.',
  'roles.new.permissions.help':
    'Tick what “{label}” may do. Nothing is ticked in advance: the role carries only what you grant it, and can be changed later from its drawer.',
  'roles.new.help':
    'The key is the identifier and never changes afterwards. Permissions are chosen at the next step, before creation.',

  'roles.form.name': 'Name',
  'roles.form.namePlaceholder': 'Tier 1 support',
  'roles.form.key': 'Key',
  'roles.form.keyPlaceholder': 'tier-1-support',
  'roles.form.keyTaken': 'That key is already taken.',
  'roles.form.keyHint': 'Final. Lowercase and dashes.',
  'roles.form.description': 'Description',
  'roles.form.descriptionPlaceholder': 'Read-only, plus rerunning scans',
  'roles.form.submit': 'Create the role',

  'roles.locked': 'locked',
  'roles.noDescription': 'No description.',
  'roles.permissionCount': {
    one: '{count} / {total} permission',
    other: '{count} / {total} permissions',
  },
  'roles.userCount': { one: '{count} user', other: '{count} users' },
  'roles.action.collapse': 'Collapse',
  'roles.action.view': 'View',
  'roles.new.action': 'New role',
  'roles.delete.title': 'Delete the role “{label}”?',
  'roles.delete.gone': 'The role leaves the list of assignable roles; no user carries it.',
  'roles.delete.audit': 'The deletion is written to the log, with the permissions it carried.',
  'roles.delete.confirm': 'Delete the role',
  'roles.deleted': 'Role “{label}” deleted',
  'roles.created': 'Role “{label}” created',
  'roles.delete.aria': 'Delete the role {label}',
  'roles.delete.inUse': {
    one: 'Carried by {count} user: reassign them before deleting this role.',
    other: 'Carried by {count} users: reassign them before deleting this role.',
  },
  'roles.changes': { one: '{count} change', other: '{count} changes' },
  'roles.saved': 'Role saved.',
  'roles.locked.notice':
    'This role is locked. It always holds every permission, including those added later, and can be neither renamed nor deleted.',
  'roles.field.label': 'Displayed name',
  'roles.field.descriptionPlaceholder': 'What is this role for?',
  'roles.group.checkAll': 'check all',
  'roles.group.uncheckAll': 'uncheck all',
  'roles.selectedCount': {
    one: '{count} / {total} selected',
    other: '{count} / {total} selected',
  },
  'roles.noChanges': 'No change',
  'roles.sensitive': 'sensitive',
  'roles.sensitive.help':
    'Sensitive permission: when the instance requires it, a role holding it enforces a second factor.',
  'roles.matrix.legend': 'Legend',
  'roles.matrix.held': 'granted',
  'roles.matrix.heldSensitive': 'sensitive, granted',
  'roles.matrix.missing': 'not granted',
  'roles.matrix.family': 'Permission family',
  'roles.matrix.open': '{action} the role {label}',
  'roles.matrix.cell': {
    one: '{family}: {count} of {total}',
    other: '{family}: {count} of {total}',
  },
  'roles.matrix.total': 'Total',
  'roles.matrix.twoFactor': 'Second factor',
  'roles.matrix.twoFactor.required': 'required',
  'roles.matrix.twoFactor.help.off':
    'The instance requires a second factor from nobody (Settings → Accounts and sessions).',
  'roles.matrix.twoFactor.help.sensitive':
    'Required from every role holding at least one sensitive permission (Settings → Accounts and sessions).',
  'roles.matrix.twoFactor.help.all':
    'Required from every account (Settings → Accounts and sessions).',

  'logs.title': 'Activity log',
  'logs.description.before':
    'Who did what, when, and from which IP. Every panel action goes through',
  'logs.description.after':
    "; these are neither a deployment's logs nor an application's. Denials are recorded just like completed actions.",
  'logs.summary': {
    one: '{count} entry · page {page}/{total}',
    other: '{count} entries · page {page}/{total}',
  },

  'logs.filter.action': 'Action',
  'logs.filter.resourceType': 'Resource type',
  'logs.filter.actor': 'Actor',
  'logs.filter.actor.all': 'Everyone',
  'logs.export': 'Export .jsonl',
  'logs.filter.from': 'From',
  'logs.filter.to': 'To',
  'logs.filter.submit': 'Filter',
  'logs.filter.search': 'Search',
  'logs.filter.search.placeholder': 'action, resource, actor, IP, content…',
  'logs.filter.severity': 'Severity',
  'logs.filter.remove': 'Remove the filter {filter}',
  'logs.column.severity': 'Severity',
  'logs.severity.low': 'LOW',
  'logs.severity.medium': 'MEDIUM',
  'logs.severity.high': 'HIGH',
  'logs.severity.critical': 'CRITICAL',
  'logs.severity.low.help': 'Routine: sign-ins, reads, successes, recoveries.',
  'logs.severity.medium.help': 'A configuration or state change, an ordinary failure or denial.',
  'logs.severity.high.help':
    'An outage, a denial that looks like an attempt, or a change to access: roles, accounts, tokens, integrations.',
  'logs.severity.critical.help':
    'Act now: an SSH fingerprint that changed, a rollback or a restore that failed.',

  'logs.empty.title': 'No entry',
  'logs.empty.hint':
    'No event matches these filters. Widen the date range or the severity, or clear the search.',

  'logs.column.actor': 'Actor',
  'logs.column.action': 'Action',
  'logs.column.resource': 'Resource',
  'logs.column.ip': 'IP',
  'logs.column.agent': 'Agent',
  'logs.anonymous': 'system / anonymous',
  'logs.viaToken': 'through token “{name}”',
  'logs.column.token': 'API token',
  'logs.denial': 'denial',
  'logs.row.open': 'Open the entry {action}',
  'logs.drawer.kind': 'Log entry',
  'logs.drawer.who': 'Who, what, where',
  'logs.drawer.payload': 'JSON payload',
  'logs.drawer.none': 'No payload for this entry.',
  'logs.drawer.copy': 'Copy the JSON',
  'logs.drawer.copied': 'JSON copied',
  'logs.drawer.filterActor': 'Filter on this actor',
  'logs.drawer.filterAction': 'Filter on this action',
  'logs.timezone': 'Timestamps in {timezone}.',

  'error.role.exists': 'A role “{key}” already exists',
  'error.role.notFound': 'Role “{key}” not found',
  'error.role.deleteFailed': 'Role “{key}” could not be deleted',

  'error.user.notFound': 'User “{id}” not found',
  'error.user.emailTaken': 'An account already exists for {email}',
  'error.user.deleteSelf': 'You cannot delete your own account',
  'error.user.disableSelf': 'You cannot disable your own account',
  'error.user.lastAdmin.delete': 'You cannot delete the last active administrator of the platform',
  'error.user.lastAdmin.disable':
    'You cannot disable the last active administrator of the platform',
  'error.user.lastAdmin.role': 'You cannot remove the last active administrator of the platform',

  'error.mail.missing.create':
    'No active email channel (SMTP): the invitation could not go out. Set one up under Settings → Notifications, or create the account with a password.',
  'error.mail.missing.resend': 'No active email channel (SMTP): the invitation could not go out.',
  'error.user.hasPassword':
    '{email} has already picked a password. A reset is asked for from the sign-in screen.',
  'error.user.banned':
    '{email} is disabled: re-enable the account before sending the invitation again.',
  'error.invitation.none': 'No link is live for {email}.',
  'error.user.no2fa': '{email} has no second factor to reset.',

  'mail.notTriggered': 'no email was triggered',
  'mail.sendFailed': 'sending impossible',
};

export const admin = { fr, en };
