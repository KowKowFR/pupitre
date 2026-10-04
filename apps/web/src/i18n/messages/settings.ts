import type { Translated } from '@pupitre/core';

/**
 * Les paramètres d'instance — le sommaire, le rail, les six sous-sections et
 * la plomberie d'enregistrement qu'elles partagent.
 *
 * Les notifications ont leur propre module (`messages/notifications.ts`) : la
 * section pèse à elle seule autant que les cinq autres réunies, et son
 * vocabulaire — canaux, secrets, résumés — ne sert nulle part ailleurs.
 *
 * Rappel de la règle : la colonne `fr` reproduit à l'identique les chaînes qui
 * existaient. `verify-settings.sh` cherche « Relancer l' » dans le HTML servi ;
 * une virgule déplacée le ferait échouer.
 */
const fr = {
  // ── Plomberie commune aux sous-sections ─────────────────────────────────
  'form.saved': 'Section enregistrée.',

  /**
   * Le catalogue des sections ne porte plus que `href`, `id` et l'icône : la
   * prose vit ici. Les clés sont indexées par l'`id` de la section, ce qui
   * permet au rail, au sommaire et à chaque sous-page de composer la clé
   * — `section.${id}.title` — sans table de correspondance.
   */

  'section.identity.label': 'Identité',
  'section.identity.title': "Identité de l'instance",
  'section.identity.short': 'le nom affiché dans le rail et les e-mails',
  'section.identity.governs':
    "Le nom et le sous-titre que le panel affiche de lui-même : en haut du rail de navigation, dans le titre de l'onglet du navigateur, et en tête de l'assistant de démarrage.",

  'section.regional.label': 'Régionalisation',
  'section.regional.title': 'Régionalisation',
  'section.regional.short': 'fuseau, langue et format des dates',
  'section.regional.governs':
    "Le fuseau, la langue et la forme de toutes les dates du panel — tableaux, journaux, horodatages des logs d'activité —, serveur et navigateur compris. Le fuseau sert aussi de défaut aux tâches planifiées créées ensuite.",

  'section.security.label': 'Analyse de sécurité',
  'section.security.title': 'Analyse de sécurité',
  'section.security.short': 'ce qui bloque une mise en ligne',
  'section.security.governs':
    "Le scan des images avant mise en ligne : quels scanners tournent, et à partir de quelle sévérité un finding empêche le déploiement. Le réglage vaut pour toute l'instance, y compris les déploiements lancés depuis l'API.",

  'section.sso.label': 'Connexion unique',
  'section.sso.title': 'Connexion unique (OpenID Connect)',
  'section.sso.short': 'se connecter par Keycloak',
  'section.sso.governs':
    "Se connecter au panel par un fournisseur d'identité — Keycloak, Authentik, Google, Microsoft Entra : tout ce qui parle OpenID Connect. Les comptes naissent à la première connexion, et leurs rôles peuvent suivre les groupes du fournisseur.",

  'section.accounts.label': 'Comptes et sessions',
  'section.accounts.title': 'Comptes et sessions',
  'section.accounts.short': 'second facteur, durée des sessions',
  'section.accounts.governs':
    'Qui doit présenter un second facteur pour entrer, et combien de temps une session reste ouverte.',

  'section.notifications.label': 'Notifications',
  'section.notifications.title': 'Notifications',
  'section.notifications.short': 'où partent les alertes',
  'section.notifications.governs':
    "Qui est prévenu, comment, et de quoi : e-mail, Telegram, Discord ou webhook. Les alertes partent des mêmes événements que les logs d'activité — un déploiement en échec, un scan qui bloque, un geste de sécurité — mais elles vont chercher quelqu'un au lieu d'attendre qu'on vienne lire.",

  'section.ai.label': 'Intelligence artificielle',
  'section.ai.title': 'Intelligence artificielle',
  'section.ai.short': "génération d'AppSpec depuis une description",
  'section.ai.governs':
    "Le fournisseur, le modèle et la clé qui servent à générer une AppSpec depuis une description, sur l'écran « Nouvelle application ». Sans clé ni variable d'environnement, la génération reste hors service.",

  'section.backups.label': 'Sauvegardes',
  'section.backups.title': 'Sauvegardes',
  'section.backups.short': 'où partent les sauvegardes, et celle de la base du panel',
  'section.backups.governs':
    "La destination des sauvegardes — S3, SFTP vers un NAS, ou un dossier monté —, la sauvegarde de la base du panel, et le nombre d'applications sauvegardées automatiquement. Chaque application règle la sienne sur sa fiche.",
  'section.integrations.label': 'Dépôts de code',
  'section.integrations.title': 'Dépôts de code',
  'section.integrations.short': 'les dépôts GitHub, GitLab et Gitea liés aux applications',
  'section.integrations.governs':
    "Les fournisseurs de code qui relient Pupitre aux dépôts — une GitHub App, une forge Gitea ou Forgejo, une instance GitLab : ils lisent le code et le pupitre.json des branches liées, et Pupitre écrit l'état des déploiements sur les commits. Le panel reste privé : c'est lui qui interroge les forges.",
  'integrations.term.github': 'GitHub',
  'integrations.term.sources': 'Applications liées',
  'integrations.github.connected': 'connectée — {name}',
  'integrations.github.none': 'non connectée',
  'integrations.term.gitea': 'Gitea / Forgejo',
  'integrations.gitea.connected': 'connectée — {url}',
  'section.onboarding.label': 'Assistant de démarrage',
  'section.onboarding.title': 'Assistant de démarrage',
  'section.onboarding.short': 'le parcours des premiers pas',
  'section.onboarding.governs':
    "Le parcours de prise en main proposé à l'arrivée sur une instance vierge. On le relance d'ici quand il a été terminé ou abandonné — c'est un raccourci vers un parcours, pas un réglage de plus.",

  // ── Coquille : bandeau de page, rail, mention de lecture seule ──────────
  'page.title': 'Paramètres',
  'page.description.short': "Réglages de l'instance, appliqués à chaud.",
  'page.description.before':
    "Réglages de l'instance, appliqués à chaud. Ils vivent dans une ligne unique de",
  'page.description.after':
    "— un seul JSONB, pour qu'ajouter un réglage ne coûte pas une migration. Les secrets — la clé d'IA, celui du client de connexion unique — sont chiffrés dans leurs propres colonnes et ne ressortent jamais d'ici.",
  'page.state.customized': 'personnalisés',
  'page.state.defaults': 'valeurs par défaut',
  'page.readonly.before': 'Lecture seule : la permission',
  'page.readonly.after':
    'est requise pour modifier ces réglages. Les sections restent consultables, leurs champs sont inactifs.',
  'nav.label': 'Sections des paramètres',
  'group.instance.label': 'Instance',
  'group.access.label': 'Sécurité et accès',
  'group.integrations.label': 'Intégrations',
  'group.operations.label': 'Exploitation',

  // ── Identité ────────────────────────────────────────────────────────────
  'identity.name.label': "Nom de l'instance",
  'identity.name.help':
    'Quarante caractères au plus : il doit tenir sur une ligne du rail, à côté du logo.',
  'identity.tagline.label': 'Sous-titre',
  'identity.tagline.placeholder': "Laisser vide pour n'afficher que le nom",
  'identity.tagline.help':
    'Utile quand plusieurs instances se ressemblent — « production », « bac à sable ».',
  'identity.preview.title': 'Aperçu du rail',
  'identity.preview.nameRequired': 'Nom requis',

  // ── Régionalisation ─────────────────────────────────────────────────────
  'regional.timezone.label': 'Fuseau horaire',
  'regional.timezone.help':
    "Toujours explicite, jamais celui du navigateur : c'est ce qui garantit que le serveur et le poste affichent la même heure pour le même événement. C'est aussi le fuseau proposé par défaut à la création d'une tâche planifiée — les tâches déjà installées gardent le leur.",
  'regional.locale.label': 'Langue et locale',
  'regional.locale.help':
    "Décide de la langue du panel, de l'ordre des composants d'une date et du nom des mois. Le changement prend effet au rendu suivant, sans redéploiement ni reconnexion, et vaut pour tout le monde : les e-mails d'invitation et les alertes partent dans cette langue.",
  'regional.dateStyle.label': 'Style de date',
  'regional.timeStyle.label': "Style d'heure",
  'regional.style.short': 'court',
  'regional.style.medium': 'moyen',
  'regional.style.long': 'long',
  'regional.preview.title': 'Aperçu',
  'regional.preview.help':
    "Instant de référence : 2026-01-15 14:32:07 UTC. L'aperçu suit les champs ci-dessus avant même d'enregistrer.",

  // ── Analyse de sécurité ─────────────────────────────────────────────────
  'security.badge.on': 'active',
  'security.badge.off': 'désactivée',
  'security.enabled.label': 'Analyser les images avant déploiement',
  'security.enabled.help':
    "Décocher coupe l'étape pour tout le monde, même si un déploiement demande explicitement des scanners.",
  'security.disabled.warning':
    'Plus aucune image ne sera analysée. Les vulnérabilités connues des dépendances de vos applications passeront sans être signalées, et le seuil de blocage devient sans effet.',
  'security.skipped.title': 'Scanners écartés',
  'security.skipped.help':
    'Utile quand un seul scanner pose problème — une base de vulnérabilités inaccessible depuis la machine cible, par exemple. Les autres continuent de tourner.',
  'security.failOn.label': 'Seuil de blocage',
  'security.failOn.help':
    "Sévérité à partir de laquelle un finding empêche la mise en ligne. Ce seuil vaut pour toute l'instance : l'écran de déploiement ne le demande plus, une politique de sécurité qui se rediscute à chaque mise en ligne n'en est pas une.",
  'security.onlyFixable.label': 'Ne bloquer que sur les failles corrigeables',
  'security.onlyFixable.help':
    "Une faille sans correctif ne se répare pas en redéployant : bloquer dessus arrête la mise en ligne sans rien offrir à faire. Coché, seul ce qu'une mise à jour règle compte pour le seuil. Chaque application peut en décider autrement, dans l'onglet « Sécurité » de sa fiche.",
  'security.frozen':
    "Le réglage s'applique au moment où un déploiement est enfilé, et la configuration retenue est gelée avec lui : réactiver l'analyse ne relance pas ce qui est déjà en file. Chaque modification est tracée dans les logs d'activité.",

  // ── Intelligence artificielle ───────────────────────────────────────────
  'ai.badge.off': 'désactivée',
  'ai.badge.missingKey': 'clé manquante',
  'ai.badge.missingKey.title': 'Aucune clé enregistrée, {envVar} vide',
  'ai.badge.on': 'activée',
  'ai.noShell':
    'Le modèle ne produit jamais de shell : il rend du JSON, validé par Zod avant que quoi que ce soit ne soit exécuté.',
  'ai.enabled.label': 'Autoriser la génération par IA',
  'ai.enabled.help':
    'Interrupteur explicite : décocher coupe la génération même si une clé est enregistrée.',
  'ai.provider.label': 'Fournisseur',
  'ai.provider.help.before': "Chaque fournisseur lit sa propre variable d'environnement de repli",
  'ai.provider.help.after': '. Une clé enregistrée ici la remplace.',
  'ai.model.label': 'Modèle',
  'ai.model.aria': 'Identifiant du modèle',
  'ai.model.other': 'Autre — saisir un identifiant',
  'ai.model.help':
    "{hint}. Prix indicatifs en dollars par million de jetons, entrée puis sortie, relevés le 11/09/2026 — ils vieillissent, et la liste n'est qu'une suggestion : tout identifiant reconnu par le fournisseur convient, y compris un modèle sorti après cette liste.",
  'ai.temperature.label': 'Température (0 à 1)',
  'ai.temperature.help': "Basse, la génération est reproductible — ce qu'on veut d'une AppSpec.",
  'ai.maxTokens.label': 'Jetons maximum',
  'ai.maxTokens.help':
    "Plafond d'une réponse. Trop bas, le JSON est tronqué et la validation échoue.",
  'ai.baseUrl.label': 'URL de base (facultatif)',
  'ai.baseUrl.placeholder': 'https://llm.interne.example/v1',
  'ai.baseUrl.help':
    "Pour une API compatible OpenAI auto-hébergée. Laissée vide, c'est l'API publique du fournisseur qui est appelée. L'URL est validée à l'enregistrement : une valeur bancale ferait échouer chaque génération sans rien dire.",
  'ai.apiKey.label': "Clé d'API",
  'ai.apiKey.placeholder.none': 'Aucune clé enregistrée',
  'ai.apiKey.placeholder.set': 'Clé enregistrée, laisser vide pour la conserver',
  'ai.apiKey.placeholder.setWithTail': 'Clé enregistrée — …{last4}, laisser vide pour la conserver',
  'ai.apiKey.help.before': 'Chiffrée en AES-256-GCM sous',
  'ai.apiKey.help.middle':
    ", comme les credentials SSH. Elle n'est jamais renvoyée par l'API ni écrite dans les logs d'activité — ce champ part toujours vide, même quand une clé est en place. Sans clé ici, le panel retombe sur",
  'ai.apiKey.help.noEnvVar': 'aucune variable d’environnement',
  'ai.apiKey.help.after': ', la variable propre à {provider}.',
  'ai.apiKey.clear': 'Effacer la clé enregistrée',

  // ── Assistant de démarrage ──────────────────────────────────────────────
  'onboarding.status.pending': 'jamais lancé',
  'onboarding.status.inProgress': 'en cours',
  'onboarding.status.dismissed': 'abandonné',
  'onboarding.status.completed': 'terminé',
  'onboarding.description':
    "Le parcours de prise en main : nommer l'instance, déclarer une première cible, créer un rôle et un compte. Il ne fait rien que ces écrans ne fassent — il les met dans l'ordre.",
  'onboarding.term.status': 'État',
  'onboarding.term.completed': 'Étapes accomplies',
  'onboarding.term.skipped': 'Étapes passées',
  'onboarding.term.currentStep': 'Étape en cours',
  'onboarding.term.runs': 'Relances',
  'onboarding.reset.help':
    "Relancer remet le parcours à zéro et vous y renvoie. Rien n'est défait : les cibles, rôles et comptes déjà créés restent en place — seul le souvenir de l'avancement est effacé.",
  'onboarding.restarting': 'Relance…',
  'onboarding.restart': "Relancer l'assistant",
  'onboarding.needPermission.before': 'La permission',
  'onboarding.needPermission.after': 'est requise pour le relancer.',
  'onboarding.resume': "Reprendre où j'en étais",

  /**
   * Les seuils de supervision se règlent depuis une cible, mais leur route est
   * une route de réglage d'instance : ses deux phrases d'échec vivent donc ici,
   * faute d'un dictionnaire de supervision.
   */
  'threshold.error.targetNotFound': 'Cible « {id} » introuvable',
  'threshold.error.notSet': 'Aucun seuil posé à cette portée pour cette métrique',

  // ── Connexion unique ────────────────────────────────────────────────────
  'sso.badge.active': 'Active',
  'sso.badge.off': 'Désactivée',
  'sso.badge.error': 'Indisponible',
  'sso.enabled.label': 'Proposer la connexion par le fournisseur d’identité',
  'sso.enabled.help':
    'Le bouton apparaît sur l’écran de connexion. Le mot de passe reste possible pour qui en a un.',
  'sso.status.active':
    'Le bouton « Se connecter avec {label} » est proposé sur l’écran de connexion.',
  'sso.status.error': 'Activée, mais pas proposée : {error}',
  'sso.provider.title': 'Le fournisseur',
  'sso.label.label': 'Nom affiché',
  'sso.label.help': 'Le texte du bouton : « Se connecter avec … ».',
  'sso.issuer.label': 'Émetteur (issuer)',
  'sso.issuer.help':
    'Pour Keycloak : l’adresse du realm. Pupitre lit sa découverte à /.well-known/openid-configuration ; le panel comme les navigateurs doivent la joindre à cette même adresse.',
  'sso.issuer.placeholder': 'https://auth.exemple.fr/realms/pupitre',
  'sso.check': 'Tester',
  'sso.check.ok': 'Le fournisseur répond : {issuer}',
  'sso.check.failed': 'Le fournisseur ne répond pas : {error}',
  'sso.clientId.label': 'Identifiant du client',
  'sso.clientId.help': 'Le client OpenID Connect créé pour Pupitre, en accès confidentiel.',
  'sso.clientSecret.label': 'Secret du client',
  'sso.clientSecret.placeholder.set': '•••••••• enregistré — laisser vide pour le garder',
  'sso.clientSecret.placeholder.none': 'Le secret de l’onglet « Credentials » du client',
  'sso.clientSecret.help': 'Chiffré sous MASTER_KEY, jamais rendu par l’API.',
  'sso.clientSecret.clear': 'Effacer le secret enregistré',
  'sso.scopes.label': 'Portées',
  'sso.scopes.help': 'Séparées par des espaces. openid est toujours demandée.',
  'sso.callback.label': 'URL de retour à déclarer chez le fournisseur',
  'sso.callback.help': 'Dans Keycloak : « Valid redirect URIs » du client.',
  'sso.callback.copy': 'Copier',
  'sso.callback.copied': 'URL copiée',
  'sso.accounts.title': 'Les comptes',
  'sso.autoCreate.label': 'Créer le compte à la première connexion',
  'sso.autoCreate.help':
    'Sinon, seules les personnes qui ont déjà un compte Pupitre peuvent entrer par le fournisseur.',
  'sso.linkByEmail.label': 'Lier un compte existant de même e-mail',
  'sso.linkByEmail.help':
    'Seulement quand le fournisseur déclare l’e-mail vérifié. Sans liaison, une personne qui a déjà un compte garde son mot de passe.',
  'sso.roles.title': 'Les rôles',
  'sso.groupsClaim.label': 'Champ des groupes',
  'sso.groupsClaim.help':
    'Où lire les groupes dans le jeton d’identité : groups, avec le mappeur « Group Membership » de Keycloak. Les rôles de realm (realm_access.roles) n’y figurent que si leur mappeur les y ajoute.',
  'sso.syncRoles.label': 'Le fournisseur fait foi',
  'sso.syncRoles.help':
    'Le rôle est recalculé à chaque connexion. Décoché, il n’est posé qu’à la création du compte, puis se règle dans Pupitre. Le dernier administrateur n’est jamais rétrogradé par là.',
  'sso.mappings.label': 'Groupe → rôle',
  'sso.mappings.help':
    'La première ligne qui correspond l’emporte : mettez les groupes les plus puissants en haut.',
  'sso.mappings.group': 'Groupe',
  'sso.mappings.role': 'Rôle',
  'sso.mappings.add': 'Ajouter une correspondance',
  'sso.mappings.remove': 'Retirer la correspondance « {group} »',
  'sso.mappings.up': 'Monter la correspondance « {group} »',
  'sso.mappings.empty': 'Aucune correspondance : tout le monde reçoit le rôle par défaut.',
  'sso.defaultRole.label': 'Rôle par défaut',
  'sso.defaultRole.help':
    'Pour qui n’a aucun groupe reconnu. « Sans accès » laisse la personne attendre qu’un administrateur choisisse.',
  'sso.error.unknownRole': 'Rôle inconnu : « {key} »',
  'sso.problem.missing': 'émetteur, identifiant ou secret du client manquant',
  'sso.problem.http': 'la découverte répond {detail}',
  'sso.problem.issuer': 'le fournisseur s’annonce « {detail} », pas comme l’émetteur saisi',
  'sso.problem.incomplete': 'découverte incomplète : {detail} absent(s)',
  'sso.problem.unreachable': 'fournisseur injoignable : {detail}',
  'sso.problem.unreadable': 'configuration illisible',

  // ── Comptes et sessions ─────────────────────────────────────────────────
  'accounts.state.off': 'au choix',
  'accounts.state.sensitive': 'exigé · droits sensibles',
  'accounts.state.all': 'exigé · tous les comptes',
  'accounts.twoFactor.title': 'Le second facteur',
  'accounts.policy.label': 'Exiger un second facteur',
  'accounts.policy.off': 'Non',
  'accounts.policy.sensitive': 'Pour les droits sensibles',
  'accounts.policy.all': 'Pour tous les comptes',
  'accounts.policy.off.help': 'Chacun l’active, ou non, depuis « Mon compte ».',
  'accounts.policy.sensitive.help':
    'Exigé de tout rôle qui porte au moins une de ces permissions — l’administrateur toujours :',
  'accounts.policy.all.help': 'Exigé de chaque compte, quel que soit son rôle.',
  'accounts.affected.roles': 'Rôles concernés : {roles}',
  'accounts.affected.none': 'Aucun rôle concerné.',
  'accounts.missing': {
    one: '{count} compte concerné n’a pas encore de second facteur : à sa prochaine page, il devra l’activer, et n’aura accès à rien d’autre d’ici là.',
    other:
      '{count} comptes concernés n’ont pas encore de second facteur : à leur prochaine page, ils devront l’activer, et n’auront accès à rien d’autre d’ici là.',
  },
  'accounts.missing.none': 'Tous les comptes concernés en ont déjà un.',
  'accounts.sso.note':
    'Un compte sans mot de passe, qui n’entre que par la connexion unique, n’y est pas tenu : son second facteur est l’affaire du fournisseur d’identité.',
  'accounts.self.warning':
    'Vous n’avez pas vous-même de second facteur : activez-le d’abord depuis « Mon compte ».',
  'accounts.error.self':
    'Activez d’abord votre propre second facteur, depuis « Mon compte » : cette politique vous l’exigerait.',
  'accounts.sessions.title': 'Les sessions',
  'accounts.idle.label': 'Fermer une session inactive après',
  'accounts.idle.help':
    'Chaque visite la prolonge. Raccourcir la durée vaut aussi pour les sessions déjà ouvertes.',
  'accounts.max.label': 'Fermer toute session après',
  'accounts.max.help':
    'Même active : il faudra se reconnecter au moins à cet intervalle, compté depuis la connexion.',
  'accounts.max.never': 'Jamais',
  'accounts.hours': { one: '{count} heure', other: '{count} heures' },
  'accounts.days': { one: '{count} jour', other: '{count} jours' },
  'accounts.max.shorter':
    'Le plafond est plus court que la durée sans activité : c’est lui qui fermera les sessions.',
} as const;

const en: Translated<typeof fr> = {
  'form.saved': 'Section saved.',

  'section.identity.label': 'Identity',
  'section.identity.title': 'Instance identity',
  'section.identity.short': 'the name shown in the rail and e-mails',
  'section.identity.governs':
    'The name and tagline the panel shows of itself: at the top of the navigation rail, in the browser tab title, and at the head of the setup guide.',

  'section.regional.label': 'Regional settings',
  'section.regional.title': 'Regional settings',
  'section.regional.short': 'time zone, language and date format',
  'section.regional.governs':
    'The time zone, the language and the shape of every date in the panel — tables, journals, activity log timestamps — server and browser alike. The time zone is also the default for scheduled jobs created afterwards.',

  'section.security.label': 'Security scanning',
  'section.security.title': 'Security scanning',
  'section.security.short': 'what blocks a rollout',
  'section.security.governs':
    'Image scanning before going live: which scanners run, and from which severity a finding blocks the deployment. The setting holds for the whole instance, deployments launched from the API included.',

  'section.sso.label': 'Single sign-on',
  'section.sso.title': 'Single sign-on (OpenID Connect)',
  'section.sso.short': 'sign in with Keycloak',
  'section.sso.governs':
    'Sign in to the panel through an identity provider — Keycloak, Authentik, Google, Microsoft Entra: anything that speaks OpenID Connect. Accounts are created on first sign-in, and their roles can follow the provider’s groups.',

  'section.accounts.label': 'Accounts and sessions',
  'section.accounts.title': 'Accounts and sessions',
  'section.accounts.short': 'second factor, session length',
  'section.accounts.governs':
    'Who must present a second factor to get in, and how long a session stays open.',

  'section.notifications.label': 'Notifications',
  'section.notifications.title': 'Notifications',
  'section.notifications.short': 'where alerts go',
  'section.notifications.governs':
    'Who is warned, how, and of what: email, Telegram, Discord or webhook. Alerts come from the same events as the activity log — a failed deployment, a blocking scan, a security move — but they go find someone instead of waiting to be read.',

  'section.ai.label': 'Artificial intelligence',
  'section.ai.title': 'Artificial intelligence',
  'section.ai.short': 'AppSpec generation from a description',
  'section.ai.governs':
    'The provider, the model and the key used to generate an AppSpec from a description, on the “New application” screen. With neither a key nor an environment variable, generation stays out of service.',

  'section.backups.label': 'Backups',
  'section.backups.title': 'Backups',
  'section.backups.short': 'where backups go, and the panel database backup',
  'section.backups.governs':
    'The backup destination — S3, SFTP to a NAS, or a mounted folder —, the panel database backup, and how many applications are backed up automatically. Each application sets its own on its page.',
  'section.integrations.label': 'Code repositories',
  'section.integrations.title': 'Code repositories',
  'section.integrations.short': 'GitHub, GitLab and Gitea repositories linked to applications',
  'section.integrations.governs':
    'The code providers that link Pupitre to repositories — a GitHub App, a Gitea or Forgejo forge, a GitLab instance: they read the code and the pupitre.json of linked branches, and Pupitre writes deployment states on commits. The panel stays private: it asks the forges itself.',
  'integrations.term.github': 'GitHub',
  'integrations.term.sources': 'Linked applications',
  'integrations.github.connected': 'connected — {name}',
  'integrations.github.none': 'not connected',
  'integrations.term.gitea': 'Gitea / Forgejo',
  'integrations.gitea.connected': 'connected — {url}',
  'section.onboarding.label': 'Setup guide',
  'section.onboarding.title': 'Setup guide',
  'section.onboarding.short': 'the first-steps walkthrough',
  'section.onboarding.governs':
    'The walkthrough offered on arrival at a blank instance. You run it again from here once it has been finished or dismissed — a shortcut to a walkthrough, not one more setting.',

  'page.title': 'Settings',
  'page.description.short': 'Instance settings, applied live.',
  'page.description.before': 'Instance settings, applied live. They live in a single row of',
  'page.description.after':
    '— one JSONB, so that adding a setting costs no migration. Secrets — the AI key, the single sign-on client’s — sit encrypted in their own columns and never come back out of here.',
  'page.state.customized': 'customized',
  'page.state.defaults': 'default values',
  'page.readonly.before': 'Read-only: permission',
  'page.readonly.after':
    'is required to change these settings. Sections stay readable, their fields are inert.',
  'nav.label': 'Settings sections',
  'group.instance.label': 'Instance',
  'group.access.label': 'Security and access',
  'group.integrations.label': 'Integrations',
  'group.operations.label': 'Operations',

  'identity.name.label': 'Instance name',
  'identity.name.help':
    'Forty characters at most: it has to fit on one line of the rail, next to the logo.',
  'identity.tagline.label': 'Tagline',
  'identity.tagline.placeholder': 'Leave empty to show the name alone',
  'identity.tagline.help': 'Useful when several instances look alike — “production”, “sandbox”.',
  'identity.preview.title': 'Rail preview',
  'identity.preview.nameRequired': 'Name required',

  'regional.timezone.label': 'Time zone',
  'regional.timezone.help':
    'Always explicit, never the browser’s: that is what guarantees the server and the workstation show the same time for the same event. It is also the time zone offered by default when a scheduled job is created — jobs already installed keep theirs.',
  'regional.locale.label': 'Language and locale',
  'regional.locale.help':
    'Decides the panel’s language, the order of the parts of a date and the names of the months. The change takes effect on the next render, with no redeploy and no sign-in again, and it holds for everyone: invitation emails and alerts go out in this language.',
  'regional.dateStyle.label': 'Date style',
  'regional.timeStyle.label': 'Time style',
  'regional.style.short': 'short',
  'regional.style.medium': 'medium',
  'regional.style.long': 'long',
  'regional.preview.title': 'Preview',
  'regional.preview.help':
    'Reference instant: 2026-01-15 14:32:07 UTC. The preview follows the fields above before you even save.',

  'security.badge.on': 'on',
  'security.badge.off': 'off',
  'security.enabled.label': 'Scan images before deployment',
  'security.enabled.help':
    'Unchecking cuts the step for everyone, even when a deployment asks for scanners explicitly.',
  'security.disabled.warning':
    'No image will be scanned any more. Known vulnerabilities in your applications’ dependencies will go unreported, and the blocking threshold becomes moot.',
  'security.skipped.title': 'Skipped scanners',
  'security.skipped.help':
    'Useful when one scanner alone is the problem — a vulnerability database unreachable from the target machine, for instance. The others keep running.',
  'security.failOn.label': 'Blocking threshold',
  'security.failOn.help':
    'Severity from which a finding blocks going live. This threshold holds for the whole instance: the deployment screen no longer asks for it — a security policy renegotiated at every rollout is not one.',
  'security.onlyFixable.label': 'Only block on fixable vulnerabilities',
  'security.onlyFixable.help':
    'A vulnerability without a fix is not repaired by redeploying: blocking on it stops the release without offering anything to do. When checked, only what an update fixes counts toward the threshold. Each application can decide otherwise, in the “Security” tab of its record.',
  'security.frozen':
    'The setting applies the moment a deployment is queued, and the configuration chosen is frozen with it: turning scanning back on does not replay what is already in the queue. Every change is traced in the activity log.',

  'ai.badge.off': 'off',
  'ai.badge.missingKey': 'key missing',
  'ai.badge.missingKey.title': 'No key saved, {envVar} empty',
  'ai.badge.on': 'on',
  'ai.noShell':
    'The model never produces shell: it returns JSON, validated by Zod before anything is executed.',
  'ai.enabled.label': 'Allow AI generation',
  'ai.enabled.help': 'An explicit switch: unchecking cuts generation even when a key is saved.',
  'ai.provider.label': 'Provider',
  'ai.provider.help.before': 'Each provider reads its own fallback environment variable',
  'ai.provider.help.after': '. A key saved here replaces it.',
  'ai.model.label': 'Model',
  'ai.model.aria': 'Model ID',
  'ai.model.other': 'Other — type an ID',
  'ai.model.help':
    '{hint}. Indicative prices in dollars per million tokens, input then output, taken on 2026-09-11 — they age, and the list is only a suggestion: any ID the provider recognizes will do, a model released after this list included.',
  'ai.temperature.label': 'Temperature (0 to 1)',
  'ai.temperature.help': 'Low, generation is reproducible — what you want from an AppSpec.',
  'ai.maxTokens.label': 'Maximum tokens',
  'ai.maxTokens.help':
    'Ceiling for one response. Too low, the JSON is truncated and validation fails.',
  'ai.baseUrl.label': 'Base URL (optional)',
  'ai.baseUrl.placeholder': 'https://llm.internal.example/v1',
  'ai.baseUrl.help':
    'For a self-hosted OpenAI-compatible API. Left empty, the provider’s public API is called. The URL is validated on save: a shaky value would fail every generation without a word.',
  'ai.apiKey.label': 'API key',
  'ai.apiKey.placeholder.none': 'No key saved',
  'ai.apiKey.placeholder.set': 'Key saved, leave empty to keep it',
  'ai.apiKey.placeholder.setWithTail': 'Key saved — …{last4}, leave empty to keep it',
  'ai.apiKey.help.before': 'Encrypted with AES-256-GCM under',
  'ai.apiKey.help.middle':
    ', like the SSH credentials. It is never returned by the API nor written to the activity log — this field always starts empty, even when a key is in place. With no key here, the panel falls back to',
  'ai.apiKey.help.noEnvVar': 'no environment variable',
  'ai.apiKey.help.after': ', the variable specific to {provider}.',
  'ai.apiKey.clear': 'Clear the saved key',

  'onboarding.status.pending': 'never run',
  'onboarding.status.inProgress': 'in progress',
  'onboarding.status.dismissed': 'dismissed',
  'onboarding.status.completed': 'finished',
  'onboarding.description':
    'The walkthrough: name the instance, declare a first target, create a role and an account. It does nothing these screens do not — it puts them in order.',
  'onboarding.term.status': 'State',
  'onboarding.term.completed': 'Steps done',
  'onboarding.term.skipped': 'Steps skipped',
  'onboarding.term.currentStep': 'Current step',
  'onboarding.term.runs': 'Restarts',
  'onboarding.reset.help':
    'Running it again resets the walkthrough and sends you back to it. Nothing is undone: targets, roles and accounts already created stay in place — only the memory of your progress is erased.',
  'onboarding.restarting': 'Restarting…',
  'onboarding.restart': 'Run the guide again',
  'onboarding.needPermission.before': 'Permission',
  'onboarding.needPermission.after': 'is required to run it again.',
  'onboarding.resume': 'Pick up where I left off',

  'threshold.error.targetNotFound': 'Target “{id}” not found',
  'threshold.error.notSet': 'No threshold set at this scope for this metric',

  'sso.badge.active': 'Active',
  'sso.badge.off': 'Off',
  'sso.badge.error': 'Unavailable',
  'sso.enabled.label': 'Offer sign-in through the identity provider',
  'sso.enabled.help':
    'The button shows on the sign-in screen. Passwords keep working for those who have one.',
  'sso.status.active': 'The “Sign in with {label}” button is offered on the sign-in screen.',
  'sso.status.error': 'Enabled, but not offered: {error}',
  'sso.provider.title': 'The provider',
  'sso.label.label': 'Display name',
  'sso.label.help': 'The button text: “Sign in with …”.',
  'sso.issuer.label': 'Issuer',
  'sso.issuer.help':
    'For Keycloak: the realm address. Pupitre reads its discovery at /.well-known/openid-configuration; the panel and browsers must both reach it at that same address.',
  'sso.issuer.placeholder': 'https://auth.example.com/realms/pupitre',
  'sso.check': 'Test',
  'sso.check.ok': 'The provider answers: {issuer}',
  'sso.check.failed': 'The provider does not answer: {error}',
  'sso.clientId.label': 'Client ID',
  'sso.clientId.help': 'The OpenID Connect client created for Pupitre, with confidential access.',
  'sso.clientSecret.label': 'Client secret',
  'sso.clientSecret.placeholder.set': '•••••••• saved — leave empty to keep it',
  'sso.clientSecret.placeholder.none': 'The secret from the client’s “Credentials” tab',
  'sso.clientSecret.help': 'Encrypted under MASTER_KEY, never returned by the API.',
  'sso.clientSecret.clear': 'Clear the saved secret',
  'sso.scopes.label': 'Scopes',
  'sso.scopes.help': 'Space-separated. openid is always requested.',
  'sso.callback.label': 'Callback URL to register with the provider',
  'sso.callback.help': 'In Keycloak: the client’s “Valid redirect URIs”.',
  'sso.callback.copy': 'Copy',
  'sso.callback.copied': 'URL copied',
  'sso.accounts.title': 'Accounts',
  'sso.autoCreate.label': 'Create the account on first sign-in',
  'sso.autoCreate.help':
    'Otherwise, only people who already have a Pupitre account can come in through the provider.',
  'sso.linkByEmail.label': 'Link an existing account with the same email',
  'sso.linkByEmail.help':
    'Only when the provider reports the email as verified. Without linking, someone who already has an account keeps their password.',
  'sso.roles.title': 'Roles',
  'sso.groupsClaim.label': 'Groups field',
  'sso.groupsClaim.help':
    'Where to read groups in the ID token: groups, with Keycloak’s “Group Membership” mapper. Realm roles (realm_access.roles) only show up there if their mapper adds them.',
  'sso.syncRoles.label': 'The provider is authoritative',
  'sso.syncRoles.help':
    'The role is recomputed at every sign-in. Unticked, it is only set when the account is created, then managed in Pupitre. The last administrator is never demoted this way.',
  'sso.mappings.label': 'Group → role',
  'sso.mappings.help': 'The first matching line wins: put the most powerful groups on top.',
  'sso.mappings.group': 'Group',
  'sso.mappings.role': 'Role',
  'sso.mappings.add': 'Add a mapping',
  'sso.mappings.remove': 'Remove the “{group}” mapping',
  'sso.mappings.up': 'Move the “{group}” mapping up',
  'sso.mappings.empty': 'No mapping: everyone gets the default role.',
  'sso.defaultRole.label': 'Default role',
  'sso.defaultRole.help':
    'For anyone with no recognised group. “No access” leaves them waiting for an administrator to choose.',
  'sso.error.unknownRole': 'Unknown role: “{key}”',
  'sso.problem.missing': 'issuer, client ID or client secret missing',
  'sso.problem.http': 'discovery answers {detail}',
  'sso.problem.issuer': 'the provider announces itself as “{detail}”, not as the entered issuer',
  'sso.problem.incomplete': 'incomplete discovery: {detail} missing',
  'sso.problem.unreachable': 'provider unreachable: {detail}',
  'sso.problem.unreadable': 'unreadable configuration',

  'accounts.state.off': 'optional',
  'accounts.state.sensitive': 'required · sensitive rights',
  'accounts.state.all': 'required · every account',
  'accounts.twoFactor.title': 'Second factor',
  'accounts.policy.label': 'Require a second factor',
  'accounts.policy.off': 'No',
  'accounts.policy.sensitive': 'For sensitive rights',
  'accounts.policy.all': 'For every account',
  'accounts.policy.off.help': 'Everyone turns it on, or not, from “My account”.',
  'accounts.policy.sensitive.help':
    'Required of any role holding at least one of these permissions — the administrator always:',
  'accounts.policy.all.help': 'Required of every account, whatever its role.',
  'accounts.affected.roles': 'Roles concerned: {roles}',
  'accounts.affected.none': 'No role concerned.',
  'accounts.missing': {
    one: '{count} account concerned has no second factor yet: on its next page, it will have to turn it on, with access to nothing else until then.',
    other:
      '{count} accounts concerned have no second factor yet: on their next page, they will have to turn it on, with access to nothing else until then.',
  },
  'accounts.missing.none': 'Every account concerned already has one.',
  'accounts.sso.note':
    'An account without a password, signing in only through single sign-on, is exempt: its second factor is the identity provider’s business.',
  'accounts.self.warning':
    'You have no second factor yourself: turn it on first from “My account”.',
  'accounts.error.self':
    'Turn on your own second factor first, from “My account”: this policy would require it of you.',
  'accounts.sessions.title': 'Sessions',
  'accounts.idle.label': 'Close an idle session after',
  'accounts.idle.help':
    'Every visit extends it. Shortening the duration also applies to sessions already open.',
  'accounts.max.label': 'Close any session after',
  'accounts.max.help':
    'Even while active: signing in again is needed at least this often, counted from sign-in.',
  'accounts.max.never': 'Never',
  'accounts.hours': { one: '{count} hour', other: '{count} hours' },
  'accounts.days': { one: '{count} day', other: '{count} days' },
  'accounts.max.shorter':
    'The cap is shorter than the idle duration: it is what will close sessions.',
};

export const settings = { fr, en };
