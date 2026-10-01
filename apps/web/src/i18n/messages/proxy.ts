import type { Translated } from '@pupitre/core';

/**
 * Les reverse proxies : les refus des routes, la carte de la cible, l'étape de
 * l'assistant, les domaines d'une application.
 */
const fr = {
  // ── refus ────────────────────────────────────────────────────────────────
  'error.targetNotFound': 'Cible introuvable.',
  'error.applicationNotFound': 'Application introuvable.',
  'error.noProxy':
    'Aucun reverse proxy sur « {target} » : réglez-le d’abord sur la page de la cible, ou dans l’assistant.',
  'error.installing': 'Une installation est déjà en cours sur cette cible.',
  'error.hasRoutes': {
    one: '{count} domaine passe encore par ce proxy : retirez-le d’abord de son application.',
    other:
      '{count} domaines passent encore par ce proxy : retirez-les d’abord de leurs applications.',
  },
  'error.httpsUnsupported':
    'Ce proxy ne sert pas en HTTPS : « {hostname} » doit être servi en HTTP.',
  'error.detectTimeout':
    'La machine n’a pas répondu à temps — le worker est peut-être occupé par un déploiement. Réessayez.',
  'error.detectFailed': 'Impossible de regarder la machine : {error}',
  'error.jobNoId': 'La tâche n’a pas reçu d’identifiant.',
  'error.unknownKind': 'Ce genre de proxy n’est pas encore pris en charge.',
  'error.acmeUrl': 'Un serveur ACME personnalisé demande son URL.',

  // ── la carte de la cible ─────────────────────────────────────────────────
  'card.title': 'Reverse proxy',
  'card.description':
    'Ce qui reçoit les visiteurs sur les ports 80 et 443 de la machine, et les mène à la bonne application selon le domaine demandé.',
  'card.none':
    'Aucun reverse proxy relié : les applications de cette machine ne sont joignables que par leur port. Pupitre peut regarder s’il y en a déjà un, ou en installer un.',
  'card.readOnly': 'Il faut la permission de modifier la cible pour régler son proxy.',
  'action.detect': 'Regarder la machine',
  'action.detecting': 'Pupitre regarde la machine…',
  'action.check': 'Tester',
  'action.remove': 'Retirer',
  'action.use': 'Utiliser celui-ci',
  'action.install': 'Installer',
  'action.cancel': 'Annuler',
  'detect.found': 'Trouvé sur la machine',
  'detect.none': 'Aucun reverse proxy reconnu sur cette machine.',
  'detect.unusable': 'Pupitre ne peut pas s’en servir tel quel.',
  'detect.install': 'Installer avec Pupitre',
  'install.container': 'Traefik en conteneur',
  'install.kubernetes': 'Le Traefik de K3s',
  'install.email': 'E-mail pour Let’s Encrypt',
  'install.email.help':
    'Let’s Encrypt y écrit avant l’expiration d’un certificat qui n’aurait pas été renouvelé.',
  'install.server': 'Autorité de certification',
  'install.server.production': 'Let’s Encrypt',
  'install.server.staging': 'Let’s Encrypt (essai)',
  'install.server.custom': 'Autre serveur ACME',
  'install.server.staging.help':
    'Certificats non reconnus par les navigateurs, sans limite de volume : pour essayer sans risque.',
  'install.server.custom.help':
    'Un ACME interne (step-ca, Smallstep…). Son certificat d’autorité, s’il n’est pas public.',
  'install.customUrl': 'URL du répertoire ACME',
  'install.caCertificate': 'Certificat de l’autorité (PEM)',
  'install.running': 'Installation en cours — elle prend une à deux minutes.',
  'install.queued': 'Installation lancée',
  'status.unknown': 'à tester',
  'status.installing': 'installation',
  'status.ok': 'opérationnel',
  'status.failed': 'en échec',
  'badge.managed': 'installé par Pupitre',
  'badge.found': 'trouvé sur la machine',
  'acme.line': 'Certificats : {server}, au nom de {email}.',
  'acme.none': 'Pas de certificats automatiques : HTTPS avec le certificat par défaut du proxy.',
  'checks.title': 'Dernier test',
  'checks.never': 'Pas encore testé.',
  'checks.queued': 'Test lancé',
  'routes.title': 'Domaines servis',
  'routes.none': 'Aucun domaine ne passe encore par ce proxy.',
  'remove.title': 'Retirer le reverse proxy de « {target} » ?',
  'remove.consequence':
    'Pupitre cesse de le piloter : les prochains déploiements de cette machine seront joignables par leur port.',
  'remove.uninstall': 'Le désinstaller aussi',
  'remove.uninstall.help':
    'Pupitre l’a installé : il arrête et retire le conteneur, ou rend à K3s sa configuration.',
  'remove.queued': 'Retrait lancé',
  connected: 'Proxy relié — test en cours',

  // ── les domaines ─────────────────────────────────────────────────────────
  'domains.title': 'Domaines',
  'domains.help': 'Servis par le reverse proxy de « {target} » ({proxy}).',
  'domains.helpAcme': ' Certificats HTTPS obtenus automatiquement.',
  'domains.noProxy':
    'Cette cible n’a pas de reverse proxy : l’application sera jointe par son port. Il se règle sur la page de la cible.',
  'domains.add': 'Ajouter un domaine',
  'domains.placeholder': 'app.exemple.fr',
  'domains.https': 'HTTPS',
  'domains.remove': 'Retirer ce domaine',
  'domains.dns.checking': 'vérification du DNS…',
  'domains.dns.ok': 'pointe vers cette machine',
  'domains.dns.elsewhere': 'pointe ailleurs ({addresses}) — normal derrière un CDN ou un NAT',
  'domains.dns.none': 'ne résout pas encore — le certificat attendra',
  'domains.save': 'Enregistrer',
  'domains.saved': 'Domaines enregistrés',
  'domains.applied': 'Domaines posés sur le proxy',
  'domains.applied.detail': 'Ils sont éprouvés à travers lui ; leur état s’affiche ici.',
  'domains.waiting':
    'L’application ne tourne pas sur cette cible : ils seront posés au prochain déploiement.',
  'domains.card.description': 'Les noms par lesquels on joint l’application, cible par cible.',
  'domains.card.empty': 'L’application ne tourne nulle part : rien à router pour l’instant.',
  'domains.card.edit': 'Modifier',
  'route.status.pending': 'en attente',
  'route.status.active': 'répond',
  'route.status.failed': 'ne répond pas',
  'cert.none': 'HTTP',
  'cert.pending': 'certificat en cours',
  'cert.valid': 'certificat jusqu’au {date}',
  'cert.invalid': 'certificat invalide',
  'cert.unknown': 'certificat illisible',
} as const;

const en: Translated<typeof fr> = {
  'error.targetNotFound': 'Target not found.',
  'error.applicationNotFound': 'Application not found.',
  'error.noProxy':
    'No reverse proxy on “{target}”: set it up first on the target page, or in the setup assistant.',
  'error.installing': 'An installation is already running on this target.',
  'error.hasRoutes': {
    one: '{count} domain still goes through this proxy: remove it from its application first.',
    other:
      '{count} domains still go through this proxy: remove them from their applications first.',
  },
  'error.httpsUnsupported':
    'This proxy does not serve HTTPS: “{hostname}” must be served over HTTP.',
  'error.detectTimeout':
    'The machine did not answer in time — the worker may be busy with a deployment. Try again.',
  'error.detectFailed': 'Could not look at the machine: {error}',
  'error.jobNoId': 'The job received no identifier.',
  'error.unknownKind': 'This kind of proxy is not supported yet.',
  'error.acmeUrl': 'A custom ACME server needs its URL.',

  'card.title': 'Reverse proxy',
  'card.description':
    'What receives visitors on ports 80 and 443 of the machine, and leads them to the right application depending on the requested domain.',
  'card.none':
    'No reverse proxy connected: applications on this machine are only reachable by their port. Pupitre can look for an existing one, or install one.',
  'card.readOnly': 'Changing the proxy requires the permission to update the target.',
  'action.detect': 'Look at the machine',
  'action.detecting': 'Pupitre is looking at the machine…',
  'action.check': 'Test',
  'action.remove': 'Remove',
  'action.use': 'Use this one',
  'action.install': 'Install',
  'action.cancel': 'Cancel',
  'detect.found': 'Found on the machine',
  'detect.none': 'No known reverse proxy on this machine.',
  'detect.unusable': 'Pupitre cannot use it as it is.',
  'detect.install': 'Install with Pupitre',
  'install.container': 'Traefik in a container',
  'install.kubernetes': 'The Traefik of K3s',
  'install.email': 'E-mail for Let’s Encrypt',
  'install.email.help':
    'Let’s Encrypt writes there before a certificate that was not renewed expires.',
  'install.server': 'Certificate authority',
  'install.server.production': 'Let’s Encrypt',
  'install.server.staging': 'Let’s Encrypt (staging)',
  'install.server.custom': 'Other ACME server',
  'install.server.staging.help':
    'Certificates not trusted by browsers, without volume limits: to try things safely.',
  'install.server.custom.help':
    'An internal ACME (step-ca, Smallstep…). Its authority certificate, if it is not public.',
  'install.customUrl': 'ACME directory URL',
  'install.caCertificate': 'Authority certificate (PEM)',
  'install.running': 'Installation running — it takes one or two minutes.',
  'install.queued': 'Installation started',
  'status.unknown': 'to test',
  'status.installing': 'installing',
  'status.ok': 'working',
  'status.failed': 'failing',
  'badge.managed': 'installed by Pupitre',
  'badge.found': 'found on the machine',
  'acme.line': 'Certificates: {server}, registered to {email}.',
  'acme.none': 'No automatic certificates: HTTPS with the proxy’s default certificate.',
  'checks.title': 'Last test',
  'checks.never': 'Not tested yet.',
  'checks.queued': 'Test started',
  'routes.title': 'Domains served',
  'routes.none': 'No domain goes through this proxy yet.',
  'remove.title': 'Remove the reverse proxy of “{target}”?',
  'remove.consequence':
    'Pupitre stops driving it: the next deployments on this machine will be reachable by their port.',
  'remove.uninstall': 'Uninstall it too',
  'remove.uninstall.help':
    'Pupitre installed it: it stops and removes the container, or gives K3s back its configuration.',
  'remove.queued': 'Removal started',
  connected: 'Proxy connected — test running',

  'domains.title': 'Domains',
  'domains.help': 'Served by the reverse proxy of “{target}” ({proxy}).',
  'domains.helpAcme': ' HTTPS certificates obtained automatically.',
  'domains.noProxy':
    'This target has no reverse proxy: the application will be reached by its port. It is set up on the target page.',
  'domains.add': 'Add a domain',
  'domains.placeholder': 'app.example.com',
  'domains.https': 'HTTPS',
  'domains.remove': 'Remove this domain',
  'domains.dns.checking': 'checking DNS…',
  'domains.dns.ok': 'points to this machine',
  'domains.dns.elsewhere': 'points elsewhere ({addresses}) — normal behind a CDN or a NAT',
  'domains.dns.none': 'does not resolve yet — the certificate will wait',
  'domains.save': 'Save',
  'domains.saved': 'Domains saved',
  'domains.applied': 'Domains set on the proxy',
  'domains.applied.detail': 'They are tested through it; their state shows here.',
  'domains.waiting':
    'The application does not run on this target: they will be set at the next deployment.',
  'domains.card.description': 'The names the application is reached by, target by target.',
  'domains.card.empty': 'The application runs nowhere: nothing to route yet.',
  'domains.card.edit': 'Edit',
  'route.status.pending': 'pending',
  'route.status.active': 'answers',
  'route.status.failed': 'not answering',
  'cert.none': 'HTTP',
  'cert.pending': 'certificate in progress',
  'cert.valid': 'certificate until {date}',
  'cert.invalid': 'invalid certificate',
  'cert.unknown': 'unreadable certificate',
};

export const proxy = { fr, en };
