import type { Translated } from '@pupitre/core';

/**
 * A running application's console: the header and its operating gestures, the
 * services inventory, the log terminal and the context drawn from the database
 * (release, machine, site probe). The refusals of the `/api/apps/{id}/…` routes
 * live here too: they are the same gestures, said by the server.
 *
 * ── What stays literal ──────────────────────────────────────────────────────
 * `scan:read`, `target:read`, `monitor:read`, `GET`, `mCPU`: they are permission
 * names, an HTTP method and a unit. Translating them would send the reader
 * looking for something that does not exist.
 */
const fr = {
  // ── Header ──────────────────────────────────────────────────────────────
  'page.description':
    "Ce que la machine dit d'elle-même, relu en direct. La colonne de gauche vient de la base du panel : elle répond même quand la machine se tait.",
  'page.restored': 'version restaurée',
  'drawer.kind': 'Application en marche',
  'gone.description': 'Ce déploiement ne tourne plus.',
  'gone.alert':
    "Ce déploiement est « {status} » : il n'y a pas d'application à suivre. Consultez son {link}.",
  'gone.link': 'historique de déploiement',
  'failedUpdate.text':
    "La dernière mise à jour a échoué (déploiement #{number}{step}). C'est la version {current} ci-dessous qui reste en service.",
  'failedUpdate.step': ', étape {step}',
  'failedUpdate.link': 'Voir le déploiement échoué',

  // ── Operations ──────────────────────────────────────────────────────────
  'ops.label': 'Exploitation',
  'ops.reading': "Lecture de l'état…",
  'ops.running': 'En marche sur {target}',
  'ops.version': ', version #{number}',
  'ops.version.spec': ', version #{number} ({spec})',
  'ops.stopped': 'Arrêtée le {date}',
  'ops.stopped.detail': ' — données et port réservé conservés.',
  'ops.none':
    'Votre rôle ne permet aucun geste sur cette application. La consultation des logs reste ouverte.',
  'ops.readFailed': 'Lecture impossible (HTTP {status})',
  'ops.readFailed.generic': 'Lecture impossible',
  'ops.failed': 'Échec (HTTP {status})',
  'ops.timeout':
    "La tâche n'a rien changé au bout de trois minutes. Elle a pu échouer : le journal d'activité et les logs de l'application le diront.",

  'gesture.stop': 'Arrêter',
  'gesture.start': 'Démarrer',
  'gesture.rollback': 'Revenir à #{number}',
  'gesture.rollback.none': 'Revenir en arrière',
  'gesture.redeploy': 'Redéployer',
  'gesture.destroy': 'Détruire…',
  'busy.stop': 'Arrêt…',
  'busy.start': 'Démarrage…',
  'busy.rollback': 'Retour en arrière…',
  'busy.redeploy': 'Mise en file…',
  'busy.destroy': 'Destruction…',

  'toast.stop': '{slug} arrêtée',
  'toast.stop.detail': 'Données et port conservés · Démarrer pour relancer',
  'toast.start': '{slug} remise en marche',
  'toast.rollback': '{slug} ramenée à une version précédente',
  'toast.destroy': '{slug} détruite sur {target}',

  'stop.title': 'Arrêter {slug} sur {target} ?',
  'stop.containers.docker': 'Les conteneurs sont arrêtés, pas supprimés.',
  'stop.containers.k3s':
    'Les pods sont retirés (répliques à zéro), les manifests restent en place.',
  'stop.kept': 'Les volumes et le port {port} restent réservés.',
  'stop.kept.noPort': "Les volumes sont conservés ; l'adresse publique cessera de répondre.",
  'stop.probe': "La sonde de santé est suspendue jusqu'au redémarrage.",
  'stop.resume': '« Démarrer » remettra cette même version en service, sans redéploiement.',
  'stop.confirm': 'Arrêter',

  'rollback.none':
    "Aucune version précédente sur cette cible : il n'y a nulle part où revenir. Une version antérieure se redéploie depuis la fiche de l'application.",
  'rollback.title': 'Revenir à la version #{number} ?',
  'rollback.lead': 'La release #{number}, déjà présente sur {target}, est remise en service.',
  'rollback.noRebuild':
    "Aucune image n'est reconstruite et aucun scan n'est rejoué : c'est la release déjà déposée qui repart.",
  'rollback.status':
    'Le déploiement courant passe au statut « rollback effectué » ; il reste dans l’historique.',
  'rollback.volumes':
    'Les volumes ne sont pas touchés : une migration de base déjà passée ne sera pas défaite.',
  'rollback.restart': 'Cette application est arrêtée : le retour en arrière la remettra en marche.',
  'rollback.confirm': 'Revenir en arrière',

  'redeploy.title': 'Redéployer la même version ?',
  'redeploy.lead':
    "Utile quand une image mutable a bougé ou qu'un secret a changé : la même AppSpec est rejouée de bout en bout.",
  'redeploy.new': 'Un nouveau déploiement est créé, avec son propre numéro et son propre pipeline.',
  'redeploy.images':
    'Les images sont retirées ou reconstruites, et la politique de scan est appliquée à nouveau.',
  'redeploy.swap': 'Les services en marche sont remplacés à la fin du pipeline, pas avant.',
  'redeploy.rollback':
    'En cas d’échec du healthcheck, le rollback automatique ramène la version actuelle.',
  'redeploy.confirm': 'Lancer le redéploiement',

  'destroy.title': 'Détruire {slug} sur {target} ?',
  'destroy.lead': "Le projet est démonté sur la machine. C'est irréversible.",
  'destroy.workspace.docker': 'Projet Compose {workspace} démonté sur {target}',
  'destroy.workspace.k3s': 'Namespace {workspace} démonté sur {target}',
  'destroy.volumes': 'Volumes supprimés, avec leurs données — base de données comprise',
  'destroy.port': 'Port {port} libéré et rendu à la réserve, sonde suspendue',
  'destroy.ingress': "Entrée d'Ingress retirée : l'adresse cessera de répondre",
  'destroy.releases': "Répertoire de l'application et toutes ses releases effacés de la machine",
  'destroy.kept':
    "L'historique des déploiements et l'application restent en base : vous pourrez la redéployer ici ou ailleurs.",
  'destroy.confirm': 'Détruire',

  // ── Services ────────────────────────────────────────────────────────────
  'services.title': 'Services',
  'services.probed': 'sondée il y a {age}',
  'services.neverProbed': 'jamais sondée',
  'services.awaiting': 'Premier relevé en attente : la machine est en train de répondre.',
  'services.waiting': 'En attente du flux…',
  'services.none':
    "La cible ne rapporte aucun conteneur pour ce projet, et la spec n'en déclare aucun.",
  'services.footer.interrupted': 'Aucun relevé : le flux est interrompu.',
  'services.footer.pending': 'Premier relevé en attente…',
  'services.footer.read': 'Relevé de la machine {age}, renouvelé tant que la page reste ouverte.',
  'services.running': {
    one: '{running} / {count} conteneur en marche',
    other: '{running} / {count} conteneurs en marche',
  },
  'age.ago': 'il y a {age}',
  'age.now': "à l'instant",

  'state.running': 'en marche',
  'state.restarting': 'redémarre',
  'state.exited': 'arrêté',
  'state.paused': 'en pause',
  'state.created': 'créé',
  'state.unknown': 'inconnu',
  'state.awaited': 'relevé attendu',
  'state.missing': 'non rapporté par la cible',

  'service.health.healthy': 'sonde au vert',
  'service.health.unhealthy': 'sonde au rouge',
  'service.health.starting': 'sonde en attente',
  'service.exposed': 'exposé',
  'service.built': 'image construite sur la cible',
  'service.port': 'port {port}',
  'service.after': 'après {services}',
  'service.replicas': { one: '{count} réplique', other: '{count} répliques' },
  'service.requested': '{cpu} mCPU · {memory} Mio',
  'service.probe': 'GET {path} toutes les {interval} s, {retries} essais',

  // ── Release ─────────────────────────────────────────────────────────────
  'rollout.title': 'Mise en ligne',
  'rollout.trace': 'Voir la trace',
  'rollout.version': 'Version',
  'rollout.spec': 'spec {version}',
  'rollout.runtime': 'Runtime',
  'rollout.at': 'Mise en ligne',
  'rollout.duration': 'Durée',
  'rollout.by': 'Déclenchée par',
  'rollout.byUnknown': 'origine inconnue',
  'rollout.failedStep': 'Étape en échec',
  'rollout.scan': 'Scan',
  'runtime.docker': 'Docker Compose',
  'runtime.k3s': 'K3s',
  'duration.seconds': '{seconds} s',
  'duration.minutes': '{minutes} min {seconds} s',

  'scan.restricted': 'Lire les scans demande la permission scan:read.',
  'scan.none': "Aucun scan n'a tourné pour cette version.",
  'scan.verdict.fail': 'seuil dépassé',
  'scan.verdict.pass': 'sous le seuil',
  'scan.verdict.none': 'sans verdict',
  'scan.critical': { one: '{count} critique', other: '{count} critiques' },
  'scan.high': { one: '{count} élevée', other: '{count} élevées' },
  'scan.when': '{scanners}, au moment de la mise en ligne',

  // ── The machine ─────────────────────────────────────────────────────────
  'machine.title': 'La machine',
  'machine.restricted': 'Lire les relevés machine demande la permission target:read.',
  'machine.empty': 'Aucun relevé sur {hours} h pour cette machine.',
  'machine.caption':
    "La machine entière sur {hours} h, pas cette application : la consommation par conteneur n'est pas relevée.",
  'machine.spark': 'Charge de la machine sur {hours} h',
  'gauge.load': 'chg',
  'gauge.memory': 'mém',
  'gauge.disk': 'dsk',

  // ── Site probe ──────────────────────────────────────────────────────────
  'monitor.title': 'Sonde de site',
  'monitor.restricted': 'Lire les sondes demande la permission monitor:read.',
  'monitor.none': "Aucune sonde ne surveille cette application depuis l'extérieur.",
  'monitor.create': 'En poser une',
  'monitor.since': 'depuis {age}',
  'monitor.last': 'Dernier passage à {clock}',
  'monitor.never': 'Aucun passage pour le moment',
  'monitor.latency': '{ms} ms',
  'monitor.uptime': {
    one: 'Disponibilité 24 h : {percent} % sur {count} mesure',
    other: 'Disponibilité 24 h : {percent} % sur {count} mesures',
  },
  'monitor.strip': '{count} derniers passages, du plus ancien au plus récent',

  // ── Logs ────────────────────────────────────────────────────────────────
  'logs.title': 'Logs applicatifs',
  'logs.count': { one: '{count} ligne', other: '{count} lignes' },
  'logs.countFiltered': {
    one: '{visible} sur {count} ligne',
    other: '{visible} sur {count} lignes',
  },
  'logs.flagged': { one: '{count} signalée', other: '{count} signalées' },
  'connection.connecting': 'ouverture du flux…',
  'connection.live': 'en direct',
  'connection.closed': 'flux fermé',
  'connection.error': 'reconnexion…',
  'logs.frozen': {
    one: 'figé · {count} ligne retenue',
    other: 'figé · {count} lignes retenues',
  },
  'logs.frozen.none': 'figé · aucune ligne depuis',
  'logs.pause': 'Pause',
  'logs.resume': 'Reprendre',
  'logs.pause.tip':
    "Le flux continue d'arriver pendant la pause : aucune ligne n'est perdue, elles sont seulement retenues.",
  'logs.export': 'Exporter',
  'logs.export.log': 'Fichier .log',
  'logs.export.jsonl': 'Fichier .jsonl',
  'logs.export.empty': 'Rien à exporter : aucune ligne ne passe les filtres.',
  'logs.export.scope':
    'Le tampon du navigateur : au plus les {max} dernières lignes reçues depuis l’ouverture de cette page.',
  'logs.filter': 'Filtrer les lignes reçues…',
  'logs.filter.label': 'Filtrer les lignes reçues',
  'logs.service.all': 'tous les services',
  'logs.service.label': 'Filtrer par service',
  'logs.onlyFlagged': 'Signalées seulement',
  'logs.onlyFlagged.tip':
    "Ne garder que les lignes où figure un mot d'erreur ou d'avertissement. C'est une heuristique sur le texte, pas une analyse du format.",
  'logs.empty.filtered': 'Aucune ligne du tampon ne passe les filtres.',
  'logs.empty.silent': "Aucune ligne pour l'instant : l'application est silencieuse.",
  'logs.empty.opening': 'Ouverture du flux…',
  'notice.restart': 'Redémarrage : {detail}',
  'notice.restart.pending': 'en cours',

  'export.title': 'Logs applicatifs — {slug} v{version}',
  'export.target': 'Cible : {name} ({host}) · {runtime}',
  'export.count': {
    one: '{count} ligne : le tampon affiché par le navigateur, rien de plus.',
    other: '{count} lignes : le tampon affiché par le navigateur, rien de plus.',
  },
  'export.notPersisted':
    "Ce flux n'est pas persisté : aucune ligne antérieure à l'ouverture de cette page",
  'export.notPersisted.end':
    "n'y figure, et seules les {max} dernières lignes reçues sont conservées.",
  'export.filter.service': 'Filtre : seul le service « {service} » est exporté.',
  'export.filter.query': 'Filtre : seules les lignes contenant « {query} ».',
  'export.filter.flagged':
    "Filtre : seules les lignes où figure un mot d'erreur ou d'avertissement.",
  'export.at': 'Exporté le {date}',

  // ── Route refusals ──────────────────────────────────────────────────────
  'error.alreadyStopped': 'Cette application est déjà arrêtée depuis le {date}.',
  'error.notStopped': "Cette application n'est pas arrêtée : il n'y a rien à démarrer.",
  'error.notSupervisable.stop': "Un déploiement « {status} » n'a pas d'application à arrêter.",
  'error.notSupervisable.start': "Un déploiement « {status} » n'a pas d'application à démarrer.",
  'error.notRestartable': 'Un déploiement « {status} » ne se redémarre pas.',
  'error.stoppedRestart':
    'Cette application est arrêtée : démarrez-la plutôt que de la redémarrer.',
  'error.notFollowable': "Ce déploiement est « {status} » : il n'y a pas d'application à suivre.",
  'stream.unavailable': 'flux indisponible',
  'stream.openFailed': "le flux n'a pas pu être ouvert",
} as const;

const en: Translated<typeof fr> = {
  'page.description':
    'What the host says about itself, read live. The left column comes from the panel database: it answers even when the host is silent.',
  'page.restored': 'version restored',
  'drawer.kind': 'Running application',
  'gone.description': 'This deployment is no longer running.',
  'gone.alert': 'This deployment is “{status}”: there is no application to follow. See its {link}.',
  'gone.link': 'deployment history',
  'failedUpdate.text':
    'The last update failed (deployment #{number}{step}). Version {current} below stays in service.',
  'failedUpdate.step': ', step {step}',
  'failedUpdate.link': 'View the failed deployment',

  'ops.label': 'Operations',
  'ops.reading': 'Reading the state…',
  'ops.running': 'Running on {target}',
  'ops.version': ', version #{number}',
  'ops.version.spec': ', version #{number} ({spec})',
  'ops.stopped': 'Stopped on {date}',
  'ops.stopped.detail': ' — data and reserved port kept.',
  'ops.none': 'Your role allows no gesture on this application. The logs stay readable.',
  'ops.readFailed': 'Cannot read (HTTP {status})',
  'ops.readFailed.generic': 'Cannot read',
  'ops.failed': 'Failed (HTTP {status})',
  'ops.timeout':
    'The job changed nothing after three minutes. It may have failed: the activity log and the application logs will tell.',

  'gesture.stop': 'Stop',
  'gesture.start': 'Start',
  'gesture.rollback': 'Back to #{number}',
  'gesture.rollback.none': 'Roll back',
  'gesture.redeploy': 'Redeploy',
  'gesture.destroy': 'Destroy…',
  'busy.stop': 'Stopping…',
  'busy.start': 'Starting…',
  'busy.rollback': 'Rolling back…',
  'busy.redeploy': 'Queueing…',
  'busy.destroy': 'Destroying…',

  'toast.stop': '{slug} stopped',
  'toast.stop.detail': 'Data and port kept · Start to relaunch',
  'toast.start': '{slug} running again',
  'toast.rollback': '{slug} back to a previous version',
  'toast.destroy': '{slug} destroyed on {target}',

  'stop.title': 'Stop {slug} on {target}?',
  'stop.containers.docker': 'Containers are stopped, not removed.',
  'stop.containers.k3s': 'Pods are removed (replicas at zero), the manifests stay in place.',
  'stop.kept': 'Volumes and port {port} stay reserved.',
  'stop.kept.noPort': 'Volumes are kept; the public address will stop answering.',
  'stop.probe': 'The health probe is suspended until restart.',
  'stop.resume': '“Start” puts this same version back in service, without a redeploy.',
  'stop.confirm': 'Stop',

  'rollback.none':
    'No previous version on this target: there is nowhere to go back to. An older version is redeployed from the application page.',
  'rollback.title': 'Go back to version #{number}?',
  'rollback.lead': 'Release #{number}, already on {target}, is put back in service.',
  'rollback.noRebuild':
    'No image is rebuilt and no scan is replayed: the release already on the host starts again.',
  'rollback.status': 'The current deployment becomes “rolled back”; it stays in the history.',
  'rollback.volumes':
    'Volumes are not touched: a database migration already applied is not undone.',
  'rollback.restart': 'This application is stopped: rolling back starts it again.',
  'rollback.confirm': 'Roll back',

  'redeploy.title': 'Redeploy the same version?',
  'redeploy.lead':
    'Useful when a mutable image moved or a secret changed: the same AppSpec is replayed end to end.',
  'redeploy.new': 'A new deployment is created, with its own number and its own pipeline.',
  'redeploy.images': 'Images are pulled or rebuilt, and the scan policy is applied again.',
  'redeploy.swap': 'Running services are replaced at the end of the pipeline, not before.',
  'redeploy.rollback':
    'If the healthcheck fails, automatic rollback brings back the current version.',
  'redeploy.confirm': 'Start the redeploy',

  'destroy.title': 'Destroy {slug} on {target}?',
  'destroy.lead': 'The project is taken down on the host. This cannot be undone.',
  'destroy.workspace.docker': 'Compose project {workspace} taken down on {target}',
  'destroy.workspace.k3s': 'Namespace {workspace} taken down on {target}',
  'destroy.volumes': 'Volumes deleted, with their data — database included',
  'destroy.port': 'Port {port} released back to the pool, probe suspended',
  'destroy.ingress': 'Ingress entry removed: the address will stop answering',
  'destroy.releases': 'Application directory and all its releases erased from the host',
  'destroy.kept':
    'The deployment history and the application stay in the database: you can redeploy it here or elsewhere.',
  'destroy.confirm': 'Destroy',

  'services.title': 'Services',
  'services.probed': 'probed {age} ago',
  'services.neverProbed': 'never probed',
  'services.awaiting': 'First readout pending: the host is answering.',
  'services.waiting': 'Waiting for the stream…',
  'services.none': 'The target reports no container for this project, and the spec declares none.',
  'services.footer.interrupted': 'No readout: the stream is interrupted.',
  'services.footer.pending': 'First readout pending…',
  'services.footer.read': 'Host readout {age}, renewed while this page stays open.',
  'services.running': {
    one: '{running} / {count} container running',
    other: '{running} / {count} containers running',
  },
  'age.ago': '{age} ago',
  'age.now': 'just now',

  'state.running': 'running',
  'state.restarting': 'restarting',
  'state.exited': 'exited',
  'state.paused': 'paused',
  'state.created': 'created',
  'state.unknown': 'unknown',
  'state.awaited': 'readout pending',
  'state.missing': 'not reported by the target',

  'service.health.healthy': 'probe green',
  'service.health.unhealthy': 'probe red',
  'service.health.starting': 'probe pending',
  'service.exposed': 'exposed',
  'service.built': 'image built on the target',
  'service.port': 'port {port}',
  'service.after': 'after {services}',
  'service.replicas': { one: '{count} replica', other: '{count} replicas' },
  'service.requested': '{cpu} mCPU · {memory} MiB',
  'service.probe': 'GET {path} every {interval} s, {retries} tries',

  'rollout.title': 'Rollout',
  'rollout.trace': 'View the trace',
  'rollout.version': 'Version',
  'rollout.spec': 'spec {version}',
  'rollout.runtime': 'Runtime',
  'rollout.at': 'Went live',
  'rollout.duration': 'Duration',
  'rollout.by': 'Triggered by',
  'rollout.byUnknown': 'unknown origin',
  'rollout.failedStep': 'Failed step',
  'rollout.scan': 'Scan',
  'runtime.docker': 'Docker Compose',
  'runtime.k3s': 'K3s',
  'duration.seconds': '{seconds} s',
  'duration.minutes': '{minutes} min {seconds} s',

  'scan.restricted': 'Reading scans takes the scan:read permission.',
  'scan.none': 'No scan ran for this version.',
  'scan.verdict.fail': 'over the threshold',
  'scan.verdict.pass': 'under the threshold',
  'scan.verdict.none': 'no verdict',
  'scan.critical': { one: '{count} critical', other: '{count} critical' },
  'scan.high': { one: '{count} high', other: '{count} high' },
  'scan.when': '{scanners}, at rollout time',

  'machine.title': 'The host',
  'machine.restricted': 'Reading host readouts takes the target:read permission.',
  'machine.empty': 'No readout over {hours} h for this host.',
  'machine.caption':
    'The whole host over {hours} h, not this application: per-container usage is not measured.',
  'machine.spark': 'Host load over {hours} h',
  'gauge.load': 'load',
  'gauge.memory': 'mem',
  'gauge.disk': 'disk',

  'monitor.title': 'Site monitor',
  'monitor.restricted': 'Reading monitors takes the monitor:read permission.',
  'monitor.none': 'No monitor watches this application from the outside.',
  'monitor.create': 'Set one up',
  'monitor.since': 'for {age}',
  'monitor.last': 'Last check at {clock}',
  'monitor.never': 'No check yet',
  'monitor.latency': '{ms} ms',
  'monitor.uptime': {
    one: '24 h availability: {percent}% over {count} sample',
    other: '24 h availability: {percent}% over {count} samples',
  },
  'monitor.strip': 'Last {count} checks, oldest to newest',

  'logs.title': 'Application logs',
  'logs.count': { one: '{count} line', other: '{count} lines' },
  'logs.countFiltered': { one: '{visible} of {count} line', other: '{visible} of {count} lines' },
  'logs.flagged': { one: '{count} flagged', other: '{count} flagged' },
  'connection.connecting': 'opening the stream…',
  'connection.live': 'live',
  'connection.closed': 'stream closed',
  'connection.error': 'reconnecting…',
  'logs.frozen': { one: 'frozen · {count} line held', other: 'frozen · {count} lines held' },
  'logs.frozen.none': 'frozen · no line since',
  'logs.pause': 'Pause',
  'logs.resume': 'Resume',
  'logs.pause.tip':
    'The stream keeps arriving during the pause: no line is lost, they are only held back.',
  'logs.export': 'Export',
  'logs.export.log': '.log file',
  'logs.export.jsonl': '.jsonl file',
  'logs.export.empty': 'Nothing to export: no line passes the filters.',
  'logs.export.scope':
    'The browser buffer: at most the last {max} lines received since this page opened.',
  'logs.filter': 'Filter received lines…',
  'logs.filter.label': 'Filter received lines',
  'logs.service.all': 'all services',
  'logs.service.label': 'Filter by service',
  'logs.onlyFlagged': 'Flagged only',
  'logs.onlyFlagged.tip':
    'Keep only lines containing an error or warning word. It is a heuristic on the text, not a format parser.',
  'logs.empty.filtered': 'No line of the buffer passes the filters.',
  'logs.empty.silent': 'No line yet: the application is silent.',
  'logs.empty.opening': 'Opening the stream…',
  'notice.restart': 'Restart: {detail}',
  'notice.restart.pending': 'in progress',

  'export.title': 'Application logs — {slug} v{version}',
  'export.target': 'Target: {name} ({host}) · {runtime}',
  'export.count': {
    one: '{count} line: the buffer shown by the browser, nothing more.',
    other: '{count} lines: the buffer shown by the browser, nothing more.',
  },
  'export.notPersisted':
    'This stream is not persisted: no line older than the opening of this page',
  'export.notPersisted.end': 'is included, and only the last {max} lines received are kept.',
  'export.filter.service': 'Filter: only service “{service}” is exported.',
  'export.filter.query': 'Filter: only lines containing “{query}”.',
  'export.filter.flagged': 'Filter: only lines containing an error or warning word.',
  'export.at': 'Exported on {date}',

  'error.alreadyStopped': 'This application has been stopped since {date}.',
  'error.notStopped': 'This application is not stopped: there is nothing to start.',
  'error.notSupervisable.stop': 'A “{status}” deployment has no application to stop.',
  'error.notSupervisable.start': 'A “{status}” deployment has no application to start.',
  'error.notRestartable': 'A “{status}” deployment cannot be restarted.',
  'error.stoppedRestart': 'This application is stopped: start it rather than restart it.',
  'error.notFollowable': 'This deployment is “{status}”: there is no application to follow.',
  'stream.unavailable': 'stream unavailable',
  'stream.openFailed': 'the stream could not be opened',
};

export const appConsole = { fr, en };
