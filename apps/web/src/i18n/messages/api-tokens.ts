import type { Translated } from '@pupitre/core';

/**
 * API tokens: the "My account" card, the creation drawer, the instance's list on
 * "Users", and their routes' refusals.
 */
const fr = {
  'card.title': 'Jetons d’API',
  'card.description':
    'Pour qu’une CI — GitHub Actions, GitLab CI —, un script ou un agent IA par MCP agisse en votre nom, sans navigateur. Un jeton n’a jamais plus de droits que vous, et perd ceux que vous perdez.',
  'card.new': 'Nouveau jeton',
  'card.docs': 'API et MCP : la documentation',
  'admin.title': 'Jetons d’API de l’instance',
  'admin.description':
    'Ce qui peut agir sans navigateur, et au nom de qui. Révoquer un jeton coupe aussitôt la CI qui s’en sert.',
  'empty.title': 'Aucun jeton',
  'empty.hint':
    'Un jeton s’envoie dans l’en-tête « Authorization: Bearer » : c’est ce qui permet à une CI de déployer après avoir construit son image.',
  'admin.empty.hint': 'Personne n’a encore créé de jeton d’API sur cette instance.',

  'status.active': 'Actif',
  'status.revoked': 'Révoqué',
  'status.expired': 'Échu',
  'row.permissions': { one: '{count} permission', other: '{count} permissions' },
  'row.applications.all': 'toutes les applications',
  'row.owner': 'de {name}',
  'row.created': 'créé le {date}',
  'row.expires': 'échoit le {date}',
  'row.expired': 'échu le {date}',
  'row.noExpiry': 'sans échéance',
  'row.lastUsed': 'utilisé {when}',
  'row.lastUsedFrom': 'utilisé {when} depuis {ip}',
  'row.neverUsed': 'jamais utilisé',
  'row.revoke': 'Révoquer',
  'row.revokeLabel': 'Révoquer le jeton « {name} »',

  'revoke.title': 'Révoquer « {name} » ?',
  'revoke.description':
    'Toute CI qui s’en sert sera refusée dès maintenant. Un jeton révoqué ne se rétablit pas : il faudra en créer un autre.',
  'revoke.confirm': 'Révoquer',
  'revoke.done': 'Jeton « {name} » révoqué',

  'new.kind': 'Jeton d’API',
  'new.title': 'Nouveau jeton',
  'new.help':
    'Il agit en votre nom, avec les permissions que vous lui donnez parmi les vôtres. Il ne sera montré qu’une fois.',
  'field.name': 'Nom',
  'field.name.placeholder': 'CI GitHub — boutique',
  'field.name.hint': 'À quoi il sert : c’est ce que le journal d’activité affichera.',
  'field.expiry': 'Échéance',
  'expiry.30': '30 jours',
  'expiry.90': '90 jours',
  'expiry.365': '1 an',
  'expiry.never': 'Sans échéance',
  'expiry.never.hint':
    'Un jeton sans échéance vaut jusqu’à ce qu’on le révoque : à réserver à ce qu’on surveille.',
  'field.permissions': 'Ce qu’il peut faire',
  'preset.deploy': 'Déployer',
  'preset.deploy.hint': 'Lancer un déploiement, changer l’image, le suivre, revenir en arrière',
  'preset.read': 'Lire',
  'preset.read.hint': 'Tout ce que vous pouvez consulter',
  'preset.all': 'Tout ce que je peux faire',
  'preset.all.hint':
    'Pour un agent IA (MCP) ou un script d’automatisation : il pourra tout ce que vous pouvez aujourd’hui. Préférez un choix plus étroit quand c’est possible.',
  'preset.custom': 'Sur mesure',
  'preset.custom.hint': 'Cochez une à une, parmi vos permissions',
  'field.applications': 'Applications',
  'applications.all': 'Toutes',
  'applications.all.hint': 'Accepté partout où ses permissions le permettent.',
  'applications.some': 'Seulement celles-ci',
  'applications.some.hint':
    'Accepté seulement pour déployer ces applications, suivre leurs déploiements et revenir en arrière — refusé partout ailleurs.',
  'applications.none': 'Aucune application à proposer.',
  'new.create': 'Créer le jeton',
  'new.selected': { one: '{count} permission', other: '{count} permissions' },
  'problem.name': 'Donnez-lui un nom',
  'problem.permissions': 'Choisissez au moins une permission',
  'problem.applications': 'Choisissez au moins une application',

  'reveal.title': 'Votre jeton « {name} »',
  'reveal.warning':
    'Copiez-le maintenant : il ne sera plus jamais affiché. La base n’en garde qu’une empreinte.',
  'reveal.label': 'Jeton',
  'reveal.copy': 'Copier',
  'reveal.copied': 'Jeton copié',
  'reveal.example': 'Pour s’en servir',
  'reveal.example.hint':
    'Dans votre CI, rangez-le comme secret (« PUPITRE_TOKEN ») puis appelez l’API :',
  'reveal.mcp': 'Depuis un agent IA (MCP)',
  'reveal.mcp.hint':
    'Claude Code, Cursor, VS Code… se connectent au serveur MCP du panel avec ce jeton. Cette commande se colle telle quelle dans un terminal macOS, Linux ou Windows (PowerShell comme cmd) :',
  'reveal.mcp.config':
    'Ou, dans le fichier de configuration du client, le jeton rangé dans la variable d’environnement PUPITRE_TOKEN :',
  'reveal.mcp.insecure':
    'Ce panel est servi en HTTP : le serveur MCP refusera la connexion, pour que le jeton ne circule pas en clair. Servez le panel en HTTPS, ou passez par un tunnel SSH (ssh -L 3000:localhost:3000) et l’adresse http://localhost:3000.',
  'reveal.mcp.docs': 'Les autres clients et tous les outils, dans la documentation',
  'reveal.copyExample': 'Copier',
  'reveal.exampleCopied': 'Exemple copié',
  'reveal.done': 'J’ai copié le jeton',

  'error.unknownPermission': 'Permission inconnue : « {permission} »',
  'error.applicationNotFound': 'Application « {id} » introuvable',
  'error.tooMany':
    'Vous avez déjà {max} jetons en service : révoquez-en un avant d’en créer un autre',
  'error.notFound': 'Jeton introuvable',
};

const en: Translated<typeof fr> = {
  'card.title': 'API tokens',
  'card.description':
    'So that a CI — GitHub Actions, GitLab CI —, a script or an AI agent through MCP acts on your behalf, without a browser. A token never has more rights than you, and loses the ones you lose.',
  'card.new': 'New token',
  'card.docs': 'API and MCP: the documentation',
  'admin.title': 'Instance API tokens',
  'admin.description':
    'What can act without a browser, and on whose behalf. Revoking a token cuts off the CI using it right away.',
  'empty.title': 'No token',
  'empty.hint':
    'A token goes in the “Authorization: Bearer” header: that is how a CI deploys after building its image.',
  'admin.empty.hint': 'Nobody has created an API token on this instance yet.',

  'status.active': 'Active',
  'status.revoked': 'Revoked',
  'status.expired': 'Expired',
  'row.permissions': { one: '{count} permission', other: '{count} permissions' },
  'row.applications.all': 'all applications',
  'row.owner': 'by {name}',
  'row.created': 'created {date}',
  'row.expires': 'expires {date}',
  'row.expired': 'expired {date}',
  'row.noExpiry': 'no expiry',
  'row.lastUsed': 'used {when}',
  'row.lastUsedFrom': 'used {when} from {ip}',
  'row.neverUsed': 'never used',
  'row.revoke': 'Revoke',
  'row.revokeLabel': 'Revoke token “{name}”',

  'revoke.title': 'Revoke “{name}”?',
  'revoke.description':
    'Any CI using it is refused from now on. A revoked token cannot be restored: you will have to create another one.',
  'revoke.confirm': 'Revoke',
  'revoke.done': 'Token “{name}” revoked',

  'new.kind': 'API token',
  'new.title': 'New token',
  'new.help':
    'It acts on your behalf, with the permissions you give it among your own. It is shown only once.',
  'field.name': 'Name',
  'field.name.placeholder': 'GitHub CI — shop',
  'field.name.hint': 'What it is for: this is what the activity log will show.',
  'field.expiry': 'Expiry',
  'expiry.30': '30 days',
  'expiry.90': '90 days',
  'expiry.365': '1 year',
  'expiry.never': 'No expiry',
  'expiry.never.hint':
    'A token without expiry lasts until it is revoked: keep it for what you watch.',
  'field.permissions': 'What it can do',
  'preset.deploy': 'Deploy',
  'preset.deploy.hint': 'Start a deployment, change the image, follow it, roll back',
  'preset.read': 'Read',
  'preset.read.hint': 'Everything you can read',
  'preset.all': 'Everything I can do',
  'preset.all.hint':
    'For an AI agent (MCP) or an automation script: it can do everything you can today. Prefer a narrower set when you can.',
  'preset.custom': 'Custom',
  'preset.custom.hint': 'Tick them one by one, among your permissions',
  'field.applications': 'Applications',
  'applications.all': 'All',
  'applications.all.hint': 'Accepted wherever its permissions allow.',
  'applications.some': 'Only these',
  'applications.some.hint':
    'Accepted only to deploy these applications, follow their deployments and roll back — refused everywhere else.',
  'applications.none': 'No application to offer.',
  'new.create': 'Create token',
  'new.selected': { one: '{count} permission', other: '{count} permissions' },
  'problem.name': 'Give it a name',
  'problem.permissions': 'Pick at least one permission',
  'problem.applications': 'Pick at least one application',

  'reveal.title': 'Your token “{name}”',
  'reveal.warning':
    'Copy it now: it will never be shown again. The database only keeps a fingerprint.',
  'reveal.label': 'Token',
  'reveal.copy': 'Copy',
  'reveal.copied': 'Token copied',
  'reveal.example': 'How to use it',
  'reveal.example.hint': 'In your CI, store it as a secret (“PUPITRE_TOKEN”) then call the API:',
  'reveal.mcp': 'From an AI agent (MCP)',
  'reveal.mcp.hint':
    'Claude Code, Cursor, VS Code… connect to the panel’s MCP server with this token. This command pastes as it is into a macOS, Linux or Windows terminal (PowerShell or cmd):',
  'reveal.mcp.config':
    'Or, in the client’s configuration file, with the token in the PUPITRE_TOKEN environment variable:',
  'reveal.mcp.insecure':
    'This panel is served over HTTP: the MCP server will refuse the connection, so that the token does not travel in clear. Serve the panel over HTTPS, or go through an SSH tunnel (ssh -L 3000:localhost:3000) and the address http://localhost:3000.',
  'reveal.mcp.docs': 'Other clients and every tool, in the documentation',
  'reveal.copyExample': 'Copy',
  'reveal.exampleCopied': 'Example copied',
  'reveal.done': 'I copied the token',

  'error.unknownPermission': 'Unknown permission: “{permission}”',
  'error.applicationNotFound': 'Application “{id}” not found',
  'error.tooMany': 'You already have {max} live tokens: revoke one before creating another',
  'error.notFound': 'Token not found',
};

export const apiTokens = { fr, en };
