import type { Translated } from '@pupitre/core';

/**
 * Reverse proxies: the routes' refusals, the target's card, the assistant's step,
 * an application's domains.
 */
const fr = {
  // ── refus ────────────────────────────────────────────────────────────────
  'error.targetNotFound': 'Cible introuvable.',
  'error.routeTaken': 'le domaine « {hostname} » est déjà routé vers « {application} »',
  'error.routeTakenElsewhere': 'le domaine « {hostname} » est déjà routé',
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
  'error.hasOwnProxy':
    'Cette machine a son propre reverse proxy : retirez-le avant de la relier à celui d’une autre.',
  'error.linked':
    'Cette machine passe par le reverse proxy d’une autre : déliez-la avant de lui en donner un.',
  'error.proxyNotFound': 'Ce reverse proxy n’existe plus.',
  'error.noLink': 'Cette machine n’est reliée à aucun autre proxy.',
  'error.linkNeedsIp':
    'Ce reverse proxy joint une autre machine par son adresse IPv4 : donnez une adresse, pas un nom.',
  'error.linkUnsupported': 'Ce reverse proxy ne sait pas servir une autre machine que la sienne.',
  'error.notRemote':
    'Ce genre de proxy tourne sur une machine : il se trouve ou s’installe depuis la page de la cible.',
  'error.remoteCheckFailed': 'La connexion ne marche pas — {problems}',

  // ── the target's card ────────────────────────────────────────────────────
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
  'install.email': 'E-mail pour Let’s Encrypt',
  'install.email.help':
    'Let’s Encrypt y écrit avant l’expiration d’un certificat qui n’aurait pas été renouvelé.',
  'install.server': 'Autorité de certification',
  'install.server.production': 'Let’s Encrypt',
  'install.server.staging': 'Let’s Encrypt (essai)',
  'install.server.custom': 'Autre serveur ACME',
  'install.server.zerossl': 'ZeroSSL',
  'install.server.zerossl.help':
    'Une autre autorité gratuite, reconnue par les navigateurs. Le compte est créé à partir de l’e-mail.',
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
  'acme.own': 'Certificats obtenus par le proxy, selon ses propres réglages.',
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
  'connect.done': 'Proxy relié — test en cours',

  // ── le proxy central ─────────────────────────────────────────────────────
  'link.title': 'Ou passer par un autre reverse proxy',
  'link.help':
    'Celui d’une autre machine, ou un Nginx Proxy Manager connecté à Pupitre. Il reçoit les visiteurs et les mène jusqu’ici. Entre les deux, le trafic n’est pas chiffré : préférez une adresse privée — réseau privé de l’hébergeur, VLAN, WireGuard.',
  'link.none': 'Aucun autre reverse proxy pour l’instant.',
  'link.remoteGroup': 'Hors des cibles',
  'link.proxy': 'Reverse proxy',
  'link.address': 'Adresse de cette machine, vue de celle du proxy',
  'link.address.help':
    'Celle par laquelle le proxy la joindra — une IP privée de préférence. Le port des applications n’y sera ouvert qu’à lui. « Relier » éprouve aussitôt la connexion entre les deux machines.',
  'link.reached':
    'Connexion éprouvée : « {target} » a joint cette machine sur un port de la plage des applications. Elle l’est de nouveau avant chaque déploiement.',
  'link.via': 'Servie par le reverse proxy de « {target} »',
  'link.viaRemote': 'Servie par « {target} »',
  'link.addresses': 'Le proxy joint cette machine à {address}.',
  'link.source':
    ' Il arrive depuis {source} : le port des applications ne s’ouvre qu’à cette adresse.',
  'link.public':
    '{address} n’est pas une adresse privée : entre les deux machines, le trafic passera en clair sur Internet.',
  'link.notBindable':
    '{address} n’est pas une adresse de cette machine (NAT ?) : le port des applications sera publié sur toutes ses adresses.',
  'link.status.unknown': 'à tester',
  'link.status.installing': 'à tester',
  'link.status.ok': 'reliée',
  'link.status.failed': 'en échec',
  'link.linked': 'Machine reliée — test de la liaison en cours',
  'link.unlinked': 'Machine déliée',
  'link.checked': 'Test de la liaison lancé',
  'action.link': 'Relier',
  'action.linkCheck': 'Tester la liaison',
  'action.unlink': 'Délier',
  'action.connectNpm': 'Connecter un Nginx Proxy Manager',
  'action.editRemote': 'Modifier la connexion',
  'action.checkRemote': 'Tester le proxy',
  'remote.checks': 'Dernier test du proxy',
  'remote.checked': 'Test du proxy lancé',
  // ── the connection to Nginx Proxy Manager ────────────────────────────────
  'npm.title.new': 'Connecter un Nginx Proxy Manager',
  'npm.title.edit': 'Modifier la connexion',
  'npm.kind': 'Reverse proxy distant',
  'npm.lead':
    'Pupitre ne pilote pas sa machine : il parle à son API, avec un compte à lui, et ne touche qu’aux hôtes qu’il a posés.',
  'npm.section.api': 'Son interface',
  'npm.url': 'Adresse de l’interface',
  'npm.url.help':
    'Celle de l’administration de NPM, qui porte aussi son API — souvent le port 81. En HTTP, sur un réseau privé seulement : le mot de passe y passe.',
  'npm.section.account': 'Le compte de Pupitre',
  'npm.account.help':
    'Créez-lui un compte dans NPM (Users), sans double authentification, avec « Manage » sur les Proxy Hosts et les SSL Certificates. En visibilité « Created Items », il ne voit que ce qu’il pose.',
  'npm.email': 'E-mail du compte',
  'npm.password': 'Mot de passe',
  'npm.password.keep': 'Laissez vide pour garder celui enregistré.',
  'npm.section.entrypoint': 'Où il reçoit les visiteurs',
  'npm.entrypoint.help':
    'Pupitre y sonde les domaines, depuis le panel. Vide : la machine de l’interface, ports 80 et 443.',
  'npm.entrypoint.host': 'Adresse',
  'npm.entrypoint.http': 'Port HTTP',
  'npm.entrypoint.https': 'Port HTTPS',
  'npm.name': 'Nom',
  'npm.name.help': 'Pour le reconnaître dans les listes.',
  'npm.submit.new': 'Connecter',
  'npm.submit.edit': 'Enregistrer',
  'npm.testing': 'Test de la connexion…',
  'npm.connected': 'Nginx Proxy Manager connecté',
  'npm.updated': 'Connexion enregistrée',
  'npm.checkFailed': 'Enregistrée, mais le test échoue — {problems}',
  'npm.remove': 'Retirer cette connexion',
  'npm.remove.help':
    'Refusé tant que des domaines passent par lui. Les machines qu’il sert sans domaine en sont déliées ; rien n’est retiré de NPM.',
  'npm.removed': 'Connexion retirée',
  'npm.invalid.url': 'L’adresse de l’interface est requise.',
  'npm.invalid.email': 'L’e-mail du compte est requis.',
  'npm.invalid.password': 'Le mot de passe est requis.',
  'unlink.title': 'Délier « {target} » du reverse proxy de « {via} » ?',
  'unlink.consequence':
    'Ses prochains déploiements ne seront plus servis par ce proxy : leurs domaines ne pourront plus être posés.',
  'served.title': 'Machines servies',
  'served.help': 'Leurs domaines passent par ce proxy, qui les joint à l’adresse indiquée.',
  'domains.via': 'sur « {target} »',
  'domains.waf': 'Protection du domaine',
  'domains.helpWaf':
    'BunkerWeb est aussi un pare-feu applicatif : « Protection » bloque les attaques reconnues et limite les abus, « Détection seule » les journalise sans rien bloquer — pour vérifier qu’une application n’en souffre pas —, « Sans WAF » relaie seulement.',
  'waf.block': 'Protection',
  'waf.detect': 'Détection seule',
  'waf.off': 'Sans WAF',
  'route.waf': 'WAF : {mode}',

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
  'domains.dns.okVia': 'pointe vers « {target} », la machine du proxy',
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
  'error.routeTaken': 'domain “{hostname}” is already routed to “{application}”',
  'error.routeTakenElsewhere': 'domain “{hostname}” is already routed',
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
  'error.hasOwnProxy':
    'This machine has its own reverse proxy: remove it before linking the machine to another one.',
  'error.linked':
    'This machine goes through another machine’s reverse proxy: unlink it before giving it its own.',
  'error.proxyNotFound': 'This reverse proxy no longer exists.',
  'error.noLink': 'This machine is not linked to another proxy.',
  'error.linkNeedsIp':
    'This reverse proxy reaches another machine by its IPv4 address: give an address, not a name.',
  'error.linkUnsupported': 'This reverse proxy cannot serve a machine other than its own.',
  'error.notRemote':
    'This kind of proxy runs on a machine: find or install it from the target’s page.',
  'error.remoteCheckFailed': 'The connection does not work — {problems}',

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
  'install.email': 'E-mail for Let’s Encrypt',
  'install.email.help':
    'Let’s Encrypt writes there before a certificate that was not renewed expires.',
  'install.server': 'Certificate authority',
  'install.server.production': 'Let’s Encrypt',
  'install.server.staging': 'Let’s Encrypt (staging)',
  'install.server.custom': 'Other ACME server',
  'install.server.zerossl': 'ZeroSSL',
  'install.server.zerossl.help':
    'Another free authority trusted by browsers. The account is created from the e-mail.',
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
  'acme.own': 'Certificates obtained by the proxy, per its own settings.',
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
  'connect.done': 'Proxy connected — test running',

  'link.title': 'Or go through another reverse proxy',
  'link.help':
    'Another machine’s, or a Nginx Proxy Manager connected to Pupitre. It receives visitors and leads them here. In between, traffic is not encrypted: prefer a private address — the host’s private network, a VLAN, WireGuard.',
  'link.none': 'No other reverse proxy yet.',
  'link.remoteGroup': 'Outside the targets',
  'link.proxy': 'Reverse proxy',
  'link.address': 'Address of this machine, as seen from the proxy’s',
  'link.address.help':
    'The one the proxy will reach it by — a private IP preferably. Application ports will be open to it only. “Link” tests the connection between the two machines right away.',
  'link.reached':
    'Connection tested: “{target}” reached this machine on a port of the application range. It is tested again before each deployment.',
  'link.via': 'Served by the reverse proxy of “{target}”',
  'link.viaRemote': 'Served by “{target}”',
  'link.addresses': 'The proxy reaches this machine at {address}.',
  'link.source': ' It comes from {source}: application ports open to that address only.',
  'link.public':
    '{address} is not a private address: between the two machines, traffic will cross the Internet unencrypted.',
  'link.notBindable':
    '{address} is not an address of this machine (NAT?): application ports will be published on all its addresses.',
  'link.status.unknown': 'to test',
  'link.status.installing': 'to test',
  'link.status.ok': 'linked',
  'link.status.failed': 'failing',
  'link.linked': 'Machine linked — link test running',
  'link.unlinked': 'Machine unlinked',
  'link.checked': 'Link test started',
  'action.link': 'Link',
  'action.linkCheck': 'Test the link',
  'action.unlink': 'Unlink',
  'action.connectNpm': 'Connect a Nginx Proxy Manager',
  'action.editRemote': 'Edit the connection',
  'action.checkRemote': 'Test the proxy',
  'remote.checks': 'Last proxy test',
  'remote.checked': 'Proxy test started',
  // ── the Nginx Proxy Manager connection ───────────────────────────────────
  'npm.title.new': 'Connect a Nginx Proxy Manager',
  'npm.title.edit': 'Edit the connection',
  'npm.kind': 'Remote reverse proxy',
  'npm.lead':
    'Pupitre does not drive its machine: it talks to its API, with an account of its own, and only touches the hosts it set.',
  'npm.section.api': 'Its interface',
  'npm.url': 'Interface address',
  'npm.url.help':
    'The address of NPM’s admin, which also carries its API — often port 81. Over HTTP, on a private network only: the password goes through it.',
  'npm.section.account': 'Pupitre’s account',
  'npm.account.help':
    'Create an account for it in NPM (Users), without two-factor authentication, with “Manage” on Proxy Hosts and SSL Certificates. With “Created Items” visibility, it only sees what it sets.',
  'npm.email': 'Account e-mail',
  'npm.password': 'Password',
  'npm.password.keep': 'Leave empty to keep the stored one.',
  'npm.section.entrypoint': 'Where it receives visitors',
  'npm.entrypoint.help':
    'Pupitre probes domains there, from the panel. Empty: the interface’s machine, ports 80 and 443.',
  'npm.entrypoint.host': 'Address',
  'npm.entrypoint.http': 'HTTP port',
  'npm.entrypoint.https': 'HTTPS port',
  'npm.name': 'Name',
  'npm.name.help': 'To recognise it in lists.',
  'npm.submit.new': 'Connect',
  'npm.submit.edit': 'Save',
  'npm.testing': 'Testing the connection…',
  'npm.connected': 'Nginx Proxy Manager connected',
  'npm.updated': 'Connection saved',
  'npm.checkFailed': 'Saved, but the test fails — {problems}',
  'npm.remove': 'Remove this connection',
  'npm.remove.help':
    'Refused while domains go through it. Machines it serves without a domain are unlinked; nothing is removed from NPM.',
  'npm.removed': 'Connection removed',
  'npm.invalid.url': 'The interface address is required.',
  'npm.invalid.email': 'The account e-mail is required.',
  'npm.invalid.password': 'The password is required.',
  'unlink.title': 'Unlink “{target}” from the reverse proxy of “{via}”?',
  'unlink.consequence':
    'Its next deployments will no longer be served by this proxy: their domains can no longer be set.',
  'served.title': 'Machines served',
  'served.help': 'Their domains go through this proxy, which reaches them at the address shown.',
  'domains.via': 'on “{target}”',
  'domains.waf': 'Domain protection',
  'domains.helpWaf':
    'BunkerWeb is also a web application firewall: “Protection” blocks known attacks and limits abuse, “Detection only” logs them without blocking anything — to check an application does not suffer from it —, “No WAF” only relays.',
  'waf.block': 'Protection',
  'waf.detect': 'Detection only',
  'waf.off': 'No WAF',
  'route.waf': 'WAF: {mode}',

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
  'domains.dns.okVia': 'points to “{target}”, the proxy’s machine',
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
