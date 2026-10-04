import type { Translated } from '@pupitre/core';

/**
 * Les dépôts liés : la connexion de la GitHub App, celle d'une instance
 * GitLab et celle d'une forge Gitea ou Forgejo (Paramètres → Intégrations),
 * la liaison d'une application à une branche, les commits en attente de
 * validation, et les erreurs des routes qui les servent.
 *
 * `pupitre.json`, `contents: read` et `statuses: write` ne se traduisent pas :
 * ce sont des noms de fichier et de droits, tels que GitHub les affiche.
 */
const fr = {
  // ── Paramètres → Intégrations ───────────────────────────────────────────
  'integration.title': 'GitHub',
  'integration.state.on': 'connectée',
  'integration.state.off': 'non connectée',
  'integration.connect.title': "Créer l'application GitHub",
  'integration.connect.lead':
    "Votre navigateur porte la demande jusqu'à GitHub, qui vous montre l'application avant de la créer. Vous choisissez ensuite les dépôts auxquels elle a accès. GitHub n'a jamais besoin de joindre le panel.",
  'integration.connect.owner': 'Propriétaire',
  'integration.connect.owner.personal': 'Mon compte',
  'integration.connect.owner.organization': 'Une organisation',
  'integration.connect.organization': 'Organisation',
  'integration.connect.name': "Nom de l'application",
  'integration.connect.name.help': 'Unique sur GitHub, et modifiable sur la page de création.',
  'integration.connect.permissions':
    "Droits demandés : lire le code (contents: read) et écrire l'état des déploiements sur les commits (statuses: write). Rien d'autre.",
  'integration.connect.submit': 'Créer sur GitHub',
  'integration.manual.title': 'Utiliser une application existante',
  'integration.manual.appId': 'App ID',
  'integration.manual.privateKey': 'Clé privée (.pem)',
  'integration.manual.privateKey.help':
    "Générée dans les réglages de l'application sur GitHub. Chiffrée dès l'enregistrement, jamais réaffichée.",
  'integration.manual.submit': 'Connecter',
  'integration.app': 'Application',
  'integration.owner': 'Propriétaire',
  'integration.appId': 'App ID',
  'integration.installations': 'Installations',
  'integration.installations.none':
    "L'application n'est installée nulle part : choisissez les dépôts auxquels elle a accès.",
  'integration.installation.all': 'tous les dépôts',
  'integration.installation.selected': 'dépôts choisis',
  'integration.install': 'Choisir les dépôts sur GitHub',
  'integration.manage': 'Gérer sur GitHub',
  'integration.polling': 'Le worker vérifie les branches liées toutes les minutes.',
  'integration.sources': {
    one: '{count} application liée à un dépôt',
    other: '{count} applications liées à des dépôts',
  },
  'integration.disconnect': 'Déconnecter',
  'integration.disconnect.title': 'Déconnecter GitHub ?',
  'integration.disconnect.sources': {
    one: 'La liaison de {count} application à son dépôt est supprimée.',
    other: 'Les liaisons de {count} applications à leurs dépôts sont supprimées.',
  },
  'integration.disconnect.history': 'Les déploiements passés gardent leur dépôt et leur commit.',
  'integration.disconnect.app':
    "L'application reste sur GitHub : supprimez-la depuis GitHub si vous n'en avez plus besoin.",
  'integration.connected': 'GitHub connecté',
  'integration.disconnected': 'GitHub déconnecté',
  'integration.installed':
    'Application installée : les dépôts choisis sont disponibles pour les liaisons.',
  'integration.installations.error': 'Liste des installations indisponible : {message}',
  'integration.failed':
    "GitHub n'a pas créé l'application, ou le code de retour a expiré. Recommencez : rien n'a été enregistré.",
  'integration.connect.invalid.organization': "Indiquez l'organisation.",
  'integration.connect.invalid.name': "Donnez un nom à l'application.",
  'integration.manual.invalid': "Indiquez l'App ID et collez la clé privée.",

  // ── Nouvelle application → depuis un dépôt ─────────────────────────────
  'import.section.source': 'Le dépôt',
  'import.section.spec': 'Le pupitre.json',
  'import.section.commits': 'À chaque nouveau commit',
  'import.lead':
    "Le pupitre.json d'une branche devient l'application. Vous la déployez ensuite où vous voulez, et ses commits la font évoluer.",
  'import.branch.help': 'La branche suivie : ses commits font évoluer l’application.',
  'import.searching': 'Recherche des pupitre.json de la branche…',
  'import.found': { one: '{count} pupitre.json trouvé', other: '{count} pupitre.json trouvés' },
  'import.none':
    'Aucun pupitre.json sur la branche « {branch} » : indiquez son chemin, ou ajoutez-en un au dépôt.',
  'import.specPath.help':
    'Relatif à la racine du dépôt. Seuls les changements sous son dossier concernent l’application.',
  'import.commit': 'Lu sur {branch}, au commit {sha}.',
  'import.reading': 'Lecture et validation du fichier…',
  'import.invalid': 'Ce pupitre.json ne peut pas devenir une application :',
  'import.exposed': 'exposé',
  'import.guardInfra': 'Faire valider les changements d’infrastructure',
  'import.guardInfra.help':
    'Un commit qui touche aux ports, domaines, volumes, secrets ou ressources attend un « Déployer » dans Pupitre.',
  'import.saveNote': 'Rien n’est déployé : l’application rejoint le catalogue.',
  'import.create': 'Créer l’application',
  'import.cancel': 'Annuler',
  'import.unavailable': 'Les dépôts ne sont pas disponibles.',
  'import.searchFailed': 'La recherche dans le dépôt a échoué.',
  'import.readFailed': 'Le fichier n’a pas pu être lu.',
  'import.createFailed': 'L’application n’a pas pu être créée.',
  'deployTo.none': 'Mettre à jour l’application',
  'deployTo.none.help':
    'Chaque commit qui la concerne devient sa nouvelle version. Vous la déployez où vous voulez, quand vous voulez.',
  'deployTo.running': 'La redéployer là où elle tourne',
  'deployTo.running.help':
    'Chaque commit qui la concerne est déployé sur les cibles où elle est en service. Ailleurs, rien ne s’installe.',
  'deployTo.targets': 'La déployer sur des cibles choisies',
  'deployTo.targets.help':
    'Chaque commit part sur les cibles de la liaison, qu’elle y tourne déjà ou non.',

  // ── Fiche d'une application ─────────────────────────────────────────────
  'card.title': 'Dépôt',
  'card.description':
    "Le pupitre.json d'une branche décrit l'application. Pupitre vérifie chaque minute s'il a changé.",
  'card.link': 'Relier un dépôt',
  'card.notConnected':
    "Pour relier l'application à un dépôt, connectez d'abord GitHub, GitLab ou une forge Gitea.",
  'card.notConnected.link': 'Ouvrir les intégrations',
  'card.empty': "Aucun dépôt lié : l'application se modifie depuis le panel.",
  'mode.auto': 'automatique',
  'mode.auto_unless_infra': 'automatique sauf infra',
  'mode.manual': 'toujours validé',
  'source.paused': 'en pause',
  'source.spec': 'spec',
  'source.watch': 'surveille',
  'source.targets': 'cibles',
  'source.lastSeen': 'dernier commit',
  'source.synced': 'version de l’application',
  'source.targets.running': 'là où elle tourne',
  'source.targets.none': 'à la demande, où vous voulez',
  'source.checked': 'vérifié {when}',
  'source.never':
    'Premier passage dans la minute : Pupitre note le commit en tête, sans le déployer.',
  'source.watch.default': '{paths} (par défaut)',
  'source.error': 'Dernière vérification :',
  'action.check': 'Vérifier maintenant',
  'action.deploy': 'Déployer le dernier commit',
  'action.sync': 'Mettre à jour depuis le dépôt',
  'action.edit': 'Modifier',
  'action.unlink': 'Délier',
  'toast.checking': 'Vérification enfilée',
  'toast.deploying': 'Déploiement du dernier commit enfilé',
  'toast.linked': 'Dépôt {repository} lié',
  'toast.updated': 'Liaison enregistrée',
  'toast.unlinked': 'Dépôt {repository} délié',
  'unlink.title': 'Délier {repository} ?',
  'unlink.polling': 'Pupitre cesse de suivre la branche {branch}.',
  'unlink.running': "Ce qui tourne continue de tourner : rien n'est détruit.",
  'unlink.pending': 'Les commits en attente de validation sont abandonnés.',
  'unlink.confirm': 'Délier',
  'proposal.title': 'Commit {sha} en attente de validation',
  'proposal.reason.infra': "Il touche à l'infrastructure :",
  'proposal.reason.manual': 'Cette liaison demande toujours une validation.',
  'proposal.by': 'par {author}',
  'proposal.approve': 'Déployer',
  'proposal.dismiss': 'Ignorer',
  'proposal.approved': 'Commit {sha} validé : déploiement enfilé',
  'proposal.dismissed': 'Commit {sha} ignoré',
  'proposal.change.added': 'ajouté',
  'proposal.change.removed': 'retiré',
  'proposal.change.changed': 'modifié',
  'proposal.kind.infra': 'infra',
  'proposal.kind.code': 'code',
  'proposal.received': 'reçu {when}',

  // ── Paramètres → Intégrations : les forges à jeton, Gitea / Forgejo et GitLab ──
  'gitea.title': 'Gitea / Forgejo',
  'gitea.lead':
    'Gitea, Forgejo et Codeberg, par le jeton d’accès d’un compte de la forge — de préférence un compte de service. Comme pour GitHub, Pupitre interroge la forge : elle n’a jamais besoin de joindre le panel.',
  'forge.state.on': 'connectée',
  'forge.state.off': 'non connectée',
  'forge.url': 'Adresse de la forge',
  'gitea.url.help': 'Celle qu’ouvre un navigateur : https://codeberg.org, https://git.exemple.fr.',
  'gitea.url.placeholder': 'https://codeberg.org',
  'forge.token': 'Jeton d’accès',
  'gitea.token.help':
    'Paramètres → Applications → Générer un jeton, avec les portées write:repository (lire le code, écrire l’état des déploiements sur les commits) et read:user. Chiffré dès l’enregistrement, jamais réaffiché.',
  'forge.check': 'Tester',
  'forge.check.ok': 'La forge répond : compte {login}, version {version}.',
  'forge.check.failed': 'La forge refuse : {error}',
  'forge.connect': 'Connecter la forge',
  'forge.connected': 'Forge connectée',
  'forge.replace': 'Remplacer le jeton',
  'forge.replaced': 'Jeton remplacé',
  'forge.forge': 'Forge',
  'forge.account': 'Compte du jeton',
  'forge.sources': {
    one: '{count} liaison passe par cette forge.',
    other: '{count} liaisons passent par cette forge.',
  },
  'forge.disconnect': 'Déconnecter',
  'forge.disconnect.title': 'Déconnecter {url} ?',
  'forge.disconnect.sources': {
    one: '{count} liaison sera retirée : ses applications restent, sans dépôt.',
    other: '{count} liaisons seront retirées : leurs applications restent, sans dépôt.',
  },
  'forge.disconnect.history': 'L’historique des déploiements reste, avec ses commits.',
  'forge.disconnect.token':
    'Le jeton reste valide sur la forge : révoquez-le là-bas si vous n’en avez plus besoin.',
  'forge.disconnected': 'Forge déconnectée',
  'forge.error.urlChange':
    'La forge {url} porte {count} liaison(s) : déconnectez-la avant d’en connecter une autre.',
  'forge.check.expires': 'Le jeton expire le {date}.',
  'gitlab.title': 'GitLab',
  'gitlab.lead':
    'gitlab.com ou une instance auto-hébergée, par un jeton d’accès — de préférence un jeton de projet ou de groupe, qui borne l’accès à ses projets. Comme pour GitHub, Pupitre interroge GitLab : il n’a jamais besoin de joindre le panel.',
  'gitlab.url.help':
    'Celle qu’ouvre un navigateur : https://gitlab.com, https://gitlab.exemple.fr.',
  'gitlab.url.placeholder': 'https://gitlab.com',
  'gitlab.token.help':
    'Paramètres du projet ou du groupe → Jetons d’accès, portée api — la seule qui permette d’écrire l’état des déploiements sur les commits —, rôle Maintainer : sur une branche protégée, GitLab n’accepte un statut que de qui peut y pousser (Developer suffit si les développeurs y poussent). Chiffré dès l’enregistrement, jamais réaffiché.',

  // ── Tiroir de liaison ───────────────────────────────────────────────────
  'drawer.kind': 'Dépôt',
  'drawer.title.new': 'Relier un dépôt',
  'drawer.title.edit': 'Modifier la liaison',
  'drawer.lead': 'Le dépôt dit quoi, avec son pupitre.json. Ici, vous dites où et quand.',
  'drawer.section.code': 'Le code',
  'field.repository': 'Dépôt',
  'field.repository.loading': 'Chargement des dépôts…',
  'field.repository.none': "Aucun dépôt n'est accessible aux fournisseurs connectés.",
  'field.repository.choose': 'Choisir un dépôt',
  'field.repository.grant': "Un dépôt manque ? Donnez-lui accès sur GitHub",
  'field.repository.fixed':
    "Le dépôt d'une liaison ne change pas : déliez, puis reliez pour en suivre un autre.",
  'field.branch': 'Branche',
  'field.branch.help': 'Chaque commit sur cette branche est examiné.',
  'field.specPath': 'Fichier de spec',
  'field.specPath.help':
    'Chemin depuis la racine du dépôt. Dans un monorepo : apps/api/pupitre.json.',
  'field.watchPaths': 'Chemins surveillés',
  'field.watchPaths.help':
    "Un motif par ligne. Vide : le dossier du fichier de spec. Ajoutez ce que l'application partage, par exemple packages/shared/**. Un commit hors de ces chemins est ignoré.",
  'field.targets': 'Cibles',
  'field.targets.help':
    'Chaque commit retenu part sur toutes ces cibles. Seuls les runtimes vus par le preflight sont proposés.',
  'field.targets.none': 'Aucune cible prête : lancez un preflight depuis Cibles.',
  'field.targets.runtime': 'Runtime sur {target}',
  'field.mode': 'Quand déployer',
  'field.mode.none': 'Rien ne part tout seul : la nouvelle version attend que vous la déployiez.',
  'field.enabled': 'Suivre la branche',
  'field.enabled.help': "Décoché, Pupitre cesse de vérifier, sans rien oublier de la liaison.",
  'mode.auto.title': 'Automatique',
  'mode.auto.body': 'Chaque commit retenu part aussitôt.',
  'mode.auto_unless_infra.title': "Automatique sauf changement d'infra",
  'mode.auto_unless_infra.body':
    "Le code part seul. Un commit qui touche un port, un domaine, un volume, un secret, une variable ou les ressources attend une validation, avec ce qu'il change sous les yeux.",
  'mode.manual.title': 'Toujours validé',
  'mode.manual.body': 'Chaque commit attend un clic avant de partir.',
  'mode.recommended': 'recommandé',
  'drawer.submit.new': 'Relier',
  'drawer.submit.edit': 'Enregistrer',
  'drawer.invalid.repository': 'Choisissez un dépôt.',
  'drawer.invalid.branch': 'Indiquez une branche.',
  'drawer.invalid.targets': 'Choisissez au moins une cible.',

  // ── Déploiements ────────────────────────────────────────────────────────
  'run.source': 'Commit',

  // ── Erreurs ─────────────────────────────────────────────────────────────
  'error.branchNotFound': 'La branche « {branch} » est introuvable dans ce dépôt.',
  'error.specMissing': 'Aucun {path} sur la branche « {branch} ».',
  'error.specInvalid': '{path} refusé : {issue}',
  'error.slugTaken':
    'Une application « {name} » existe déjà : le name du pupitre.json doit être libre.',
  'error.targetsRequired':
    'Choisissez au moins une cible : les commits partent sur les cibles de la liaison.',
  'error.notConnected':
    "{provider} n'est pas connecté : connectez-le dans Paramètres → Intégrations.",
  'error.state':
    'La demande de création a expiré, ou ne vient pas de ce navigateur. Recommencez depuis Paramètres → Intégrations.',
  'error.provider': 'Le fournisseur de code a refusé : {message}',
  'error.noProvider':
    "Aucun fournisseur de code n'est connecté : connectez GitHub, GitLab ou une forge Gitea dans Paramètres → Intégrations.",
  'error.privateKey': 'Clé privée illisible : collez le contenu complet du fichier .pem.',
  'error.sourceNotFound': 'Liaison « {id} » introuvable',
  'error.proposalNotFound': 'Commit en attente « {id} » introuvable',
  'error.proposalDecided': 'Ce commit a déjà été traité.',
  'error.bindingConflict': 'Cette application suit déjà cette branche de ce dépôt.',
  'error.targetNotFound': 'Cible « {id} » introuvable',
  'error.runtimeUnavailable': '{runtime} indisponible sur {target} : lancez un preflight.',
  'error.applicationNotFound': 'Application « {id} » introuvable',
  'error.repositoryUnavailable':
    "Le dépôt {repository} n'est pas accessible à Pupitre chez {provider}.",
  'error.enqueueFailed': "La tâche n'a pas pu être enfilée.",
} as const;

const en: Translated<typeof fr> = {
  'integration.title': 'GitHub',
  'integration.state.on': 'connected',
  'integration.state.off': 'not connected',
  'integration.connect.title': 'Create the GitHub App',
  'integration.connect.lead':
    'Your browser carries the request to GitHub, which shows you the app before creating it. You then pick the repositories it may access. GitHub never needs to reach the panel.',
  'integration.connect.owner': 'Owner',
  'integration.connect.owner.personal': 'My account',
  'integration.connect.owner.organization': 'An organization',
  'integration.connect.organization': 'Organization',
  'integration.connect.name': 'App name',
  'integration.connect.name.help': 'Unique on GitHub, and editable on the creation page.',
  'integration.connect.permissions':
    'Permissions requested: read the code (contents: read) and write deployment states on commits (statuses: write). Nothing else.',
  'integration.connect.submit': 'Create on GitHub',
  'integration.manual.title': 'Use an existing app',
  'integration.manual.appId': 'App ID',
  'integration.manual.privateKey': 'Private key (.pem)',
  'integration.manual.privateKey.help':
    'Generated in the app settings on GitHub. Encrypted on save, never shown again.',
  'integration.manual.submit': 'Connect',
  'integration.app': 'App',
  'integration.owner': 'Owner',
  'integration.appId': 'App ID',
  'integration.installations': 'Installations',
  'integration.installations.none':
    'The app is installed nowhere: pick the repositories it may access.',
  'integration.installation.all': 'all repositories',
  'integration.installation.selected': 'selected repositories',
  'integration.install': 'Pick repositories on GitHub',
  'integration.manage': 'Manage on GitHub',
  'integration.polling': 'The worker checks linked branches every minute.',
  'integration.sources': {
    one: '{count} application linked to a repository',
    other: '{count} applications linked to repositories',
  },
  'integration.disconnect': 'Disconnect',
  'integration.disconnect.title': 'Disconnect GitHub?',
  'integration.disconnect.sources': {
    one: 'The link of {count} application to its repository is deleted.',
    other: 'The links of {count} applications to their repositories are deleted.',
  },
  'integration.disconnect.history': 'Past deployments keep their repository and commit.',
  'integration.disconnect.app':
    'The app stays on GitHub: delete it from GitHub if you no longer need it.',
  'integration.connected': 'GitHub connected',
  'integration.disconnected': 'GitHub disconnected',
  'integration.installed': 'App installed: the chosen repositories are available for links.',
  'integration.installations.error': 'Installations unavailable: {message}',
  'integration.failed':
    'GitHub did not create the app, or the return code expired. Start again: nothing was saved.',
  'integration.connect.invalid.organization': 'Enter the organization.',
  'integration.connect.invalid.name': 'Give the app a name.',
  'integration.manual.invalid': 'Enter the App ID and paste the private key.',

  'import.section.source': 'The repository',
  'import.section.spec': 'The pupitre.json',
  'import.section.commits': 'On each new commit',
  'import.lead':
    'A branch’s pupitre.json becomes the application. You then deploy it wherever you want, and its commits make it evolve.',
  'import.branch.help': 'The branch followed: its commits make the application evolve.',
  'import.searching': 'Looking for the branch’s pupitre.json files…',
  'import.found': { one: '{count} pupitre.json found', other: '{count} pupitre.json found' },
  'import.none':
    'No pupitre.json on branch “{branch}”: give its path, or add one to the repository.',
  'import.specPath.help':
    'Relative to the repository root. Only changes under its folder concern the application.',
  'import.commit': 'Read on {branch}, at commit {sha}.',
  'import.reading': 'Reading and validating the file…',
  'import.invalid': 'This pupitre.json cannot become an application:',
  'import.exposed': 'exposed',
  'import.guardInfra': 'Require approval for infrastructure changes',
  'import.guardInfra.help':
    'A commit touching ports, domains, volumes, secrets or resources waits for a “Deploy” in Pupitre.',
  'import.saveNote': 'Nothing is deployed: the application joins the catalog.',
  'import.create': 'Create the application',
  'import.cancel': 'Cancel',
  'import.unavailable': 'Repositories are not available.',
  'import.searchFailed': 'Searching the repository failed.',
  'import.readFailed': 'The file could not be read.',
  'import.createFailed': 'The application could not be created.',
  'deployTo.none': 'Update the application',
  'deployTo.none.help':
    'Each commit concerning it becomes its new version. You deploy it wherever you want, whenever you want.',
  'deployTo.running': 'Redeploy it where it runs',
  'deployTo.running.help':
    'Each commit concerning it is deployed to the targets where it is in service. Nothing is installed elsewhere.',
  'deployTo.targets': 'Deploy it to chosen targets',
  'deployTo.targets.help':
    'Each commit goes to the link’s targets, whether it already runs there or not.',

  'card.title': 'Repository',
  'card.description':
    "A branch's pupitre.json describes the application. Pupitre checks every minute whether it changed.",
  'card.link': 'Link a repository',
  'card.notConnected':
    'To link the application to a repository, connect GitHub, GitLab or a Gitea forge first.',
  'card.notConnected.link': 'Open integrations',
  'card.empty': 'No linked repository: the application is edited from the panel.',
  'mode.auto': 'automatic',
  'mode.auto_unless_infra': 'automatic unless infra',
  'mode.manual': 'always approved',
  'source.paused': 'paused',
  'source.spec': 'spec',
  'source.watch': 'watches',
  'source.targets': 'targets',
  'source.lastSeen': 'latest commit',
  'source.synced': 'application version',
  'source.targets.running': 'where it runs',
  'source.targets.none': 'on demand, wherever you want',
  'source.checked': 'checked {when}',
  'source.never':
    'First check within a minute: Pupitre records the head commit without deploying it.',
  'source.watch.default': '{paths} (default)',
  'source.error': 'Last check:',
  'action.check': 'Check now',
  'action.deploy': 'Deploy the latest commit',
  'action.sync': 'Update from the repository',
  'action.edit': 'Edit',
  'action.unlink': 'Unlink',
  'toast.checking': 'Check queued',
  'toast.deploying': 'Deployment of the latest commit queued',
  'toast.linked': 'Repository {repository} linked',
  'toast.updated': 'Link saved',
  'toast.unlinked': 'Repository {repository} unlinked',
  'unlink.title': 'Unlink {repository}?',
  'unlink.polling': 'Pupitre stops following the {branch} branch.',
  'unlink.running': 'What runs keeps running: nothing is destroyed.',
  'unlink.pending': 'Commits awaiting approval are dropped.',
  'unlink.confirm': 'Unlink',
  'proposal.title': 'Commit {sha} awaiting approval',
  'proposal.reason.infra': 'It touches the infrastructure:',
  'proposal.reason.manual': 'This link always asks for approval.',
  'proposal.by': 'by {author}',
  'proposal.approve': 'Deploy',
  'proposal.dismiss': 'Dismiss',
  'proposal.approved': 'Commit {sha} approved: deployment queued',
  'proposal.dismissed': 'Commit {sha} dismissed',
  'proposal.change.added': 'added',
  'proposal.change.removed': 'removed',
  'proposal.change.changed': 'changed',
  'proposal.kind.infra': 'infra',
  'proposal.kind.code': 'code',
  'proposal.received': 'received {when}',

  'gitea.title': 'Gitea / Forgejo',
  'gitea.lead':
    'Gitea, Forgejo and Codeberg, through the access token of a forge account — ideally a service account. As with GitHub, Pupitre polls the forge: it never needs to reach the panel.',
  'forge.state.on': 'connected',
  'forge.state.off': 'not connected',
  'forge.url': 'Forge address',
  'gitea.url.help': 'The one a browser opens: https://codeberg.org, https://git.example.com.',
  'gitea.url.placeholder': 'https://codeberg.org',
  'forge.token': 'Access token',
  'gitea.token.help':
    'Settings → Applications → Generate token, with the write:repository scope (read the code, write deployment state on commits) and read:user. Encrypted on save, never shown again.',
  'forge.check': 'Test',
  'forge.check.ok': 'The forge answers: account {login}, version {version}.',
  'forge.check.failed': 'The forge refuses: {error}',
  'forge.connect': 'Connect the forge',
  'forge.connected': 'Forge connected',
  'forge.replace': 'Replace the token',
  'forge.replaced': 'Token replaced',
  'forge.forge': 'Forge',
  'forge.account': 'Token account',
  'forge.sources': {
    one: '{count} link goes through this forge.',
    other: '{count} links go through this forge.',
  },
  'forge.disconnect': 'Disconnect',
  'forge.disconnect.title': 'Disconnect {url}?',
  'forge.disconnect.sources': {
    one: '{count} link will be removed: its applications stay, without a repository.',
    other: '{count} links will be removed: their applications stay, without a repository.',
  },
  'forge.disconnect.history': 'Deployment history stays, with its commits.',
  'forge.disconnect.token':
    'The token stays valid on the forge: revoke it there if you no longer need it.',
  'forge.disconnected': 'Forge disconnected',
  'forge.error.urlChange':
    'Forge {url} carries {count} link(s): disconnect it before connecting another one.',
  'forge.check.expires': 'The token expires on {date}.',
  'gitlab.title': 'GitLab',
  'gitlab.lead':
    'gitlab.com or a self-managed instance, through an access token — ideally a project or group token, which limits access to its projects. As with GitHub, Pupitre polls GitLab: it never needs to reach the panel.',
  'gitlab.url.help': 'The one a browser opens: https://gitlab.com, https://gitlab.example.com.',
  'gitlab.url.placeholder': 'https://gitlab.com',
  'gitlab.token.help':
    'Project or group settings → Access tokens, api scope — the only one that can write deployment state on commits —, Maintainer role: on a protected branch, GitLab only accepts a status from someone who can push to it (Developer is enough if developers can push there). Encrypted on save, never shown again.',

  'drawer.kind': 'Repository',
  'drawer.title.new': 'Link a repository',
  'drawer.title.edit': 'Edit the link',
  'drawer.lead': 'The repository says what, with its pupitre.json. Here you say where and when.',
  'drawer.section.code': 'The code',
  'field.repository': 'Repository',
  'field.repository.loading': 'Loading repositories…',
  'field.repository.none': 'No repository is accessible to the connected providers.',
  'field.repository.choose': 'Pick a repository',
  'field.repository.grant': 'Missing a repository? Grant access on GitHub',
  'field.repository.fixed':
    "A link's repository does not change: unlink, then link to follow another one.",
  'field.branch': 'Branch',
  'field.branch.help': 'Every commit on this branch is examined.',
  'field.specPath': 'Spec file',
  'field.specPath.help': 'Path from the repository root. In a monorepo: apps/api/pupitre.json.',
  'field.watchPaths': 'Watched paths',
  'field.watchPaths.help':
    'One pattern per line. Empty: the spec file folder. Add what the application shares, for instance packages/shared/**. A commit outside these paths is ignored.',
  'field.targets': 'Targets',
  'field.targets.help':
    'Every retained commit goes to all these targets. Only runtimes seen by preflight are offered.',
  'field.targets.none': 'No ready target: run a preflight from Targets.',
  'field.targets.runtime': 'Runtime on {target}',
  'field.mode': 'When to deploy',
  'field.mode.none': 'Nothing goes out on its own: the new version waits for you to deploy it.',
  'field.enabled': 'Follow the branch',
  'field.enabled.help': 'Unchecked, Pupitre stops checking, without forgetting anything about the link.',
  'mode.auto.title': 'Automatic',
  'mode.auto.body': 'Every retained commit goes out at once.',
  'mode.auto_unless_infra.title': 'Automatic unless infrastructure changes',
  'mode.auto_unless_infra.body':
    'Code goes out alone. A commit that touches a port, a domain, a volume, a secret, a variable or resources waits for approval, with what it changes in plain sight.',
  'mode.manual.title': 'Always approved',
  'mode.manual.body': 'Every commit waits for a click before going out.',
  'mode.recommended': 'recommended',
  'drawer.submit.new': 'Link',
  'drawer.submit.edit': 'Save',
  'drawer.invalid.repository': 'Pick a repository.',
  'drawer.invalid.branch': 'Enter a branch.',
  'drawer.invalid.targets': 'Pick at least one target.',

  'run.source': 'Commit',

  'error.branchNotFound': 'Branch “{branch}” was not found in this repository.',
  'error.specMissing': 'No {path} on branch “{branch}”.',
  'error.specInvalid': '{path} rejected: {issue}',
  'error.slugTaken': 'An application “{name}” already exists: the pupitre.json name must be free.',
  'error.targetsRequired': 'Choose at least one target: commits go to the link’s targets.',
  'error.notConnected': '{provider} is not connected: connect it in Settings → Integrations.',
  'error.state':
    'The creation request expired, or did not come from this browser. Start again from Settings → Integrations.',
  'error.provider': 'The code provider refused: {message}',
  'error.noProvider':
    'No code provider is connected: connect GitHub, GitLab or a Gitea forge in Settings → Integrations.',
  'error.privateKey': 'Unreadable private key: paste the whole content of the .pem file.',
  'error.sourceNotFound': 'Link “{id}” not found',
  'error.proposalNotFound': 'Pending commit “{id}” not found',
  'error.proposalDecided': 'This commit was already handled.',
  'error.bindingConflict': 'This application already follows this branch of this repository.',
  'error.targetNotFound': 'Target “{id}” not found',
  'error.runtimeUnavailable': '{runtime} unavailable on {target}: run a preflight.',
  'error.applicationNotFound': 'Application “{id}” not found',
  'error.repositoryUnavailable':
    'Repository {repository} is not accessible to Pupitre on {provider}.',
  'error.enqueueFailed': 'The job could not be queued.',
};

export const sources = { fr, en };
