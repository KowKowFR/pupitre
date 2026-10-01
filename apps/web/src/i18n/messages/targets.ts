import type { Translated } from '@pupitre/core';

/**
 * Les cibles — la liste, la fiche, le formulaire, les panneaux de ports et de
 * charges, et les refus que renvoient les routes `/api/targets`.
 *
 * L'aide « Qu'est-ce qu'une cible ? » a son propre module (`target-help.ts`) :
 * c'est de la documentation, elle pèse à elle seule plus que tout le reste de
 * cet écran, et rien ne justifie de la charger pour afficher un tableau.
 *
 * Rappel de la règle : la colonne `fr` reproduit à l'identique les chaînes qui
 * existaient. « injoignable », « Relevé indisponible » et « initialiser » sont
 * cherchés tels quels par des scripts d'intégration.
 *
 * Ce qui ne se traduit pas et n'entre donc pas ici : `ufw`, les sorties de
 * `ufw status`, les noms de binaires et de distributions, et les commandes
 * shell.
 *
 * Le `kind` d'une charge, lui, y entre bien — mais par sa **clé**. Le driver
 * pose `container` ou `pod` ; c'est une donnée, comme le runtime. Les entrées
 * `workload.kind.*` lui donnent son mot au moment de l'afficher, et l'écran
 * retombe sur la clé nue pour un genre qu'il ne connaît pas.
 */
const fr = {
  // ── La liste ────────────────────────────────────────────────────────────
  'page.title': 'Cibles',
  'page.description':
    "Les machines sur lesquelles Pupitre déploie, joignables en SSH. Le preflight détermine ce qu'on peut y lancer : Docker, K3s, ou ni l'un ni l'autre.",
  'page.add': 'Ajouter une cible',
  'page.testAll': 'Tout tester',

  'chips.label': 'Filtrer par état',
  'chip.all': 'Toutes',
  'chip.ok': 'Opérationnelles',
  'chip.degraded': 'Dégradées',
  'chip.unreachable': 'Injoignables',
  'chip.unknown': 'Jamais testées',
  'filter.total': { one: '{count} cible', other: '{count} cibles' },

  'column.load': 'Charge 24 h',
  'load.none': 'aucun relevé sur 24 h',
  'load.silent': 'sans réponse depuis {time}',
  'gauge.load': 'chg',
  'gauge.memory': 'mém',
  'gauge.disk': 'dsk',
  'table.hint.before': "Cliquez une ligne pour l'aperçu,",
  'table.hint.after': 'pour la fiche',
  'row.more': "Plus d'actions",
  'row.open': 'Ouvrir la fiche',
  'row.preview': 'Aperçu de {name}',

  'toast.preflight.title': 'Preflight lancé sur {name}',
  'toast.preflight.detail': 'Résultat dans une dizaine de secondes, la ligne affiche la phase en direct.',
  'toast.preflightAll.title': {
    one: 'Preflight lancé sur {count} cible',
    other: 'Preflight lancé sur {count} cibles',
  },
  'toast.preflightAll.detail': 'Les statuts se mettent à jour au fil des réponses.',
  'toast.deleted': 'Cible {name} supprimée',
  'toast.created': 'Cible {name} ajoutée',
  'toast.created.detail': 'Testez la connexion pour savoir ce que la machine sait faire.',

  'drawer.kind': 'Cible',
  'drawer.tested': 'testée {ago}',
  'drawer.never': 'aucun preflight lancé',
  'drawer.alert.unreachable.title': 'Injoignable.',
  'drawer.alert.unreachable': 'La machine ne répond plus en SSH depuis {time}.',
  'drawer.alert.degraded.title': 'Preflight dégradé.',
  'drawer.alert.degraded': 'Contrôles en échec : {checks}.',
  'drawer.alert.unknown.title': 'Jamais testée.',
  'drawer.alert.unknown':
    "Rien n'est touché sur la machine avant le premier test. Lancez-le pour savoir si Docker ou K3s y sont disponibles.",
  'drawer.address': 'Adresse',
  'drawer.sudo': 'Élévation',
  'drawer.ports.used': { one: '{count} occupé', other: '{count} occupés' },
  'drawer.load': 'Charge sur 24 h',
  'drawer.load.aside': 'pire {worst} % · seuil {limit} %',
  'drawer.apps': 'Applications',
  'drawer.apps.none': 'Aucune application déployée sur cette machine.',
  'drawer.delete.title': 'Supprimer cette cible',
  'drawer.delete.free': "Retire la cible et sa clé chiffrée. Rien n'est modifié sur la machine.",

  'app.health.healthy': 'en marche',
  'app.health.unhealthy': 'répond mal',
  'app.health.unreachable': 'injoignable',
  'app.health.unknown': 'état inconnu',

  'delete.title': 'Supprimer la cible {name} ?',
  'delete.consequence.key': 'La cible et sa clé chiffrée sont retirées du panel.',
  'delete.consequence.machine':
    "Rien n'est modifié sur {host} : ni conteneur, ni fichier, ni règle de pare-feu.",
  'delete.consequence.audit': "L'opération est écrite au journal d'activité.",
  'delete.confirm': 'Supprimer la cible',

  'empty.title': 'Aucune machine cible',
  'empty.hint':
    'Déclarez une machine avec son accès SSH, puis lancez un preflight : le panel y détectera Docker, K3s et les outils de scan.',

  'filter.placeholder': 'Filtrer : nom, hôte, description, étiquette…',
  'filter.aria': 'Filtrer les machines cibles',
  'filter.showAll': 'Tout afficher',
  'filter.count': {
    one: '{count} cible sur {total}',
    other: '{count} cibles sur {total}',
  },
  'filter.none': 'Aucune cible ne correspond à ce filtre.',

  /** Titres des pastilles d'étiquette. Fournis par la table : `target-label`
   *  est rendu des deux côtés de la frontière serveur/client et n'a pas de `t`. */
  'label.filter.on': 'Filtrer sur {pair}',
  'label.filter.off': 'Retirer le filtre {pair}',

  'column.runtimes': 'Runtimes',
  'column.lastCheck': 'Dernier test',
  'table.timestamps': 'Horodatages en {timezone}.',


  // ── Preflight : le bouton, ses phases, ses échecs ───────────────────────
  'action.test': 'Tester la connexion',
  'action.testing': 'Test en cours…',
  'preflight.never': 'jamais',
  'phase.queued': 'enfilé…',
  'phase.waiting': 'en attente…',
  'phase.ssh': 'connexion SSH…',
  'phase.done': 'terminé',
  'preflight.error.timeout': 'Le preflight ne répond pas (timeout)',
  'preflight.error.poll': 'Suivi de tâche impossible (HTTP {status})',
  'preflight.error.failed': 'Le preflight a échoué',

  // ── État d'une cible. « injoignable » est cherché tel quel. ─────────────
  'status.unknown': 'jamais testée',
  'status.ok': 'opérationnelle',
  'status.degraded': 'dégradée',
  'status.unreachable': 'injoignable',

  // ── Création ────────────────────────────────────────────────────────────
  'nav.back': 'Machines cibles',
  'new.description':
    "Le panel se connectera en SSH à cette machine pour y déployer. Le credential est chiffré en base dès l'enregistrement.",
  'card.connection': 'Connexion',
  'new.card.description':
    "Rien n'est touché sur la machine à l'enregistrement. C'est le preflight — le contrôle de connexion, de sudo, de runtime et de pare-feu — qui l'ouvre pour la première fois. Il se lance depuis « Tester la connexion », et détermine ce qui sera déployable ici.",

  // ── Édition ─────────────────────────────────────────────────────────────
  'edit.title': 'Modifier « {name} »',
  'edit.description':
    "Ces réglages valent pour les prochaines connexions. Rien de ce qui tourne déjà sur cette machine n'est redéployé, et les ports déjà réservés le restent même si vous rétrécissez la plage. Après un changement d'hôte, de compte ou de clé, relancez un preflight : le relevé précédent reste affiché tel quel jusque-là.",
  'edit.card.description':
    "Le credential n'est jamais pré-rempli : laissez le champ vide pour conserver celui déjà en base.",

  // ── Le formulaire ───────────────────────────────────────────────────────
  'field.name': 'Nom',
  'field.sshUser': 'Utilisateur SSH',
  'field.host': 'Hôte',
  'field.port': 'Port',
  'field.authMethod': 'Authentification',
  'auth.key': 'Clé privée',
  'auth.password': 'Mot de passe',
  'field.sudoMethod': 'Élévation sudo',
  'sudo.nopasswd': 'sudo sans mot de passe',
  'sudo.password': 'sudo avec mot de passe',
  'field.description': 'Description',
  'description.placeholder': 'Hyperviseur du client Acme. Redémarrages hors 9h–19h uniquement.',
  'description.help':
    "À quoi sert cette machine, et ce qu'il faut savoir avant d'y toucher. Facultatif.",
  'field.credential.key': 'Clé privée SSH',
  'field.credential.password': 'Mot de passe',
  'credential.help':
    "Chiffré en AES-256-GCM avant insertion. Jamais renvoyé par l'API, jamais journalisé.",
  /** Suite de la phrase précédente, en édition seulement. L'espace initiale est
   *  celle qui séparait les deux phrases dans le JSX d'origine. */
  'credential.help.edit': ' Laissez vide pour conserver le credential actuel.',
  'field.portRange': 'Plage de ports publiables',
  'portRange.help':
    'Ce que le pare-feu de cette machine laisse passer. Chaque application déployée en Docker y réserve un port, garanti unique par la base.',
  'field.labels': 'Étiquettes',
  /** Coupée autour de `clé=valeur`, que le JSX rend en chasse fixe. */
  'labels.help.before': 'Une paire',
  'labels.help.pair': 'clé=valeur',
  'labels.help.after':
    "par ligne. La couleur est dérivée du texte : la même étiquette a partout la même teinte, et aucune ne peut prendre le vert, l'ambre ou le rouge — ces couleurs-là disent l'état d'une machine, pas son rôle.",
  'form.error.keyRequired': 'La clé privée est requise.',
  'form.error.passwordRequired': 'Le mot de passe est requis.',
  'submit.create': 'Créer la cible',

  // ── La fiche ────────────────────────────────────────────────────────────
  'detail.tabs': 'Sections de la fiche',
  'detail.tab.overview': "Vue d'ensemble",
  'detail.tab.workloads': 'Charges',
  'detail.tab.ports': 'Ports',
  'detail.tab.preflight': 'Preflight',
  'detail.tab.config': 'Configuration',
  'detail.more': "Plus d'actions",
  'detail.preview': 'Aperçu dans la liste',
  'detail.delete': 'Supprimer la cible…',
  'readout.load': 'Charge',
  'readout.memory': 'Mémoire',
  'readout.disk': 'Disque',
  'readout.uptime': 'Uptime',
  'readout.stable': 'stable',
  'readout.trend': '{value} pt',
  'readout.load.hint': {
    one: '{value} % de {count} cœur',
    other: '{value} % de {count} cœurs',
  },
  'readout.memory.hint': '{used} / {total} Gio utilisés',
  'readout.disk.hint': '{free} Gio libres sur {path}',
  'readout.uptime.days': '{days} j {hours} h',
  'readout.uptime.hours': '{hours} h {minutes} min',
  'readout.none': 'aucun relevé',
  'detail.runtimes.summary':
    'Dernier preflight le {date} ({timezone}), {ok} contrôles sur {total} réussis en {seconds} s.',
  'detail.runtimes.never': "Aucun preflight n'a encore été lancé sur cette cible.",
  'ports.sub': 'Plage {min}–{max}, {free}',
  'ports.axis': {
    one: '{count} occupé sur {capacity} · {percent} %',
    other: '{count} occupés sur {capacity} · {percent} %',
  },
  'check.status.success': 'réussi',
  'check.status.failed': 'échoué',
  'check.status.skipped': 'ignoré',
  'workload.remove.title': 'Supprimer le {kind} {name} de cette machine ?',
  'workload.remove.image': 'Image : {image}.',
  'workload.remove.final': 'La suppression est définitive : la charge ne pourra pas être relancée.',
  'workload.remove.volumes': 'Les volumes nommés, eux, sont conservés.',
  'workload.update.title': 'Mettre à jour le {kind} {name} ?',
  'workload.update.pull': "L'image {image} est retirée à sa version la plus récente.",
  'workload.update.recreate': 'La charge est recréée avec la même configuration.',
  'workload.update.downtime': 'Elle sera brièvement indisponible.',
  'label.link.title': 'Voir les cibles portant {pair}',
  'detail.runtimes.title': 'Runtimes disponibles',
  'detail.config.title': 'Configuration',
  'value.auth.key': 'clé privée',
  'value.auth.password': 'mot de passe',
  'value.sudo.nopasswd': 'sans mot de passe',
  'value.sudo.password': 'avec mot de passe',
  'field.credential': 'Credential',
  'value.credential': 'chiffré en base, non exposé',
  'field.portRangeShort': 'Plage de ports',

  // ── Les ports alloués ───────────────────────────────────────────────────
  'ports.title': 'Ports alloués',
  'ports.range': 'Plage {min}–{max}',
  'ports.used': {
    one: '{count} occupé sur {capacity}',
    other: '{count} occupés sur {capacity}',
  },
  'ports.free': { one: '{count} libre', other: '{count} libres' },
  'ports.empty': 'Aucun port réservé sur cette cible.',
  'ports.column.port': 'Port',
  'ports.column.application': 'Application',
  'ports.column.lastDeployment': 'Dernier déploiement',
  'ports.column.reservedAt': 'Réservé le',
  'ports.outOfRange': 'hors plage',
  'ports.freeSample': 'Prochains ports libres : {list}',
  'ports.exhausted': 'Plus aucun port libre dans la plage : élargissez-la avant de déployer.',

  /** `ufw` est le nom du programme : il ne se traduit dans aucune langue. */
  'firewall.unknown': 'État du pare-feu inconnu — lancez un preflight.',
  'firewall.absent.badge': 'ufw absent',
  'firewall.absent.text': 'Les ports publiés ne sont filtrés par personne.',
  'firewall.inactive.badge': 'ufw inactif',
  'firewall.inactive.text':
    "Installé mais désactivé : le panel n'y pose aucune règle et ne l'active pas.",
  'firewall.active.badge': 'ufw actif',
  'firewall.rules': {
    one: '{count} règle posée par le panel.',
    other: '{count} règles posées par le panel.',
  },

  // ── Le rapport de preflight ─────────────────────────────────────────────
  'report.title': 'Rapport de preflight',
  'report.none': "Aucun preflight n'a encore été lancé sur cette cible.",
  'report.unreachable': 'Cible injoignable',
  'report.machine': 'Machine',
  'row.os': 'Système',
  'row.kernel': 'Noyau',
  'row.latency': 'Latence SSH',
  'row.sudo': 'sudo',
  'sudo.passwordRequired': 'mot de passe requis',
  'sudo.unavailable': 'indisponible',
  'row.disk': 'Disque /',
  'disk.value': '{available} libres sur {size} ({percent} %)',
  'unit.gib': 'Gio',
  'row.memory': 'Mémoire',
  'memory.value': '{available} Mio disponibles sur {total}',
  'row.tools': 'Outils',
  'row.compose': 'Docker Compose',
  'row.readyNodes': 'Nodes prêts',
  'runtime.unavailable': '✗ indisponible',
  'report.checks.title': 'Contrôles',
  'report.checks.description':
    "Chaque contrôle est indépendant : un échec n'invalide pas les autres.",
  'column.check': 'Contrôle',

  // ── Ce qui tourne sur la machine ────────────────────────────────────────
  'workloads.title': 'Ce qui tourne sur cette machine',
  'workloads.subtitle': 'Inventaire pris en direct sur la machine, par le worker.',
  'workloads.count': { one: '{count} charge', other: '{count} charges' },
  'workloads.managed': {
    one: 'dont {count} déployée par le panel',
    other: 'dont {count} déployées par le panel',
  },
  'workloads.readout': 'relevé du {date}',
  'workloads.loading': 'Interrogation de la machine…',
  'workloads.unavailable': 'Inventaire indisponible.',
  'workloads.empty': 'Rien ne tourne sur cette machine.',
  'workloads.runtimeError': "{runtime} n'a rien pu dire : {error}",
  'workloads.error.http': 'Inventaire impossible (HTTP {status})',
  'workloads.error.plain': 'Inventaire impossible',
  'workloads.error.silent':
    "La machine a refusé l'opération sans dire pourquoi. Le journal ci-dessus porte la sortie brute du worker ; « Rafraîchir » redonne l’état réel de la machine.",

  'state.running': 'en marche',
  'state.restarting': 'redémarre',
  'state.exited': 'arrêtée',
  'state.paused': 'en pause',
  'state.created': 'créée',
  'state.unknown': 'inconnu',

  'progress.running': 'en cours',
  'progress.done': 'terminé',
  'progress.failed': 'échec',
  'progress.waiting': 'en attente du worker…',

  'column.workload': 'Charge',
  'column.origin': 'Origine',
  'column.image': 'Image',
  'column.ports': 'Ports',
  'column.createdAt': 'Créée le',
  'origin.panel': 'panel',
  'origin.outside': 'hors panel',
  'workloads.managedNotice': 'gérée par le panel — passez par son déploiement',
  'action.update': 'Mettre à jour',
  'action.more': 'Actions sur « {name} »',
  'action.start': 'Démarrer',
  'action.stop': 'Arrêter',
  'action.restart': 'Redémarrer',
  'action.logs': 'Journal',
  'action.exec': 'Console',
  'workload.menu.managed': 'Gérée par le panel',
  'workload.menu.managedApp': 'Gérée par le panel · {app}',
  'workload.stop.title': 'Arrêter {kind} « {name} » ?',
  'workload.stop.signal':
    "Le processus reçoit un signal d'arrêt, et vingt secondes pour finir proprement.",
  'workload.stop.unreachable': 'Ce qu’elle sert ne répond plus jusqu’à son prochain démarrage.',
  'workload.stop.keep':
    'Sa configuration et ses volumes restent en place : « Démarrer » la relance telle quelle.',
  'workload.restart.title': 'Redémarrer {kind} « {name} » ?',
  'workload.restart.same': 'Même image, même configuration : seul le processus repart.',
  'run.logs.kind': 'Journal',
  'run.logs.note':
    "Les dernières lignes écrites par la charge. Une lecture, pas un flux : « Relire » va les chercher à nouveau. Chaque lecture figure au journal d'audit.",
  'run.logs.tail': 'Lignes à lire',
  'run.logs.refresh': 'Relire',
  'run.logs.empty': 'La charge n’a rien écrit.',
  'run.exec.kind': 'Console',
  'run.exec.note':
    "Une commande à la fois, exécutée sous sh -c dans la charge, sans terminal interactif, deux minutes au plus. Chacune figure au journal d'audit avec son code de sortie — sa sortie, jamais.",
  'run.exec.label': 'Commande',
  'run.exec.placeholder': 'ex. ls -la /data — ↑ pour l’historique',
  'run.exec.submit': 'Exécuter',
  'run.exec.clear': 'Effacer',
  'run.exec.empty': 'Aucune commande pour l’instant.',
  'run.exec.exit': 'code de sortie {code}',
  'run.exec.timeout': 'interrompue après {seconds} s',
  'run.exec.notRunning':
    "« {name} » n'est pas en marche : démarrez-la pour y exécuter une commande.",
  'run.truncated': 'sortie coupée à {max} lignes',
  'run.streamError': 'Flux temps réel indisponible.',
  'image.unknown': 'inconnue',

  /**
   * Le genre d'une charge, tel que son runtime le nomme.
   *
   * Le driver pose une **clé** (`container`, `pod`, …) ; le mot se choisit ici,
   * et seulement ici. Un genre absent de cette liste — un runtime ajouté plus
   * tard — s'affiche tel quel : mieux vaut le mot de `kubectl` qu'une clé de
   * dictionnaire à l'écran.
   */
  'workload.kind.container': 'conteneur',
  'workload.kind.pod': 'pod',
  'workload.kind.deployment': 'deployment',
  'workload.kind.statefulset': 'statefulset',
  'workload.kind.daemonset': 'daemonset',


  // ── Les refus de l'API ──────────────────────────────────────────────────
  'error.notFound': 'Cible « {id} » introuvable',
  'error.nameTaken': 'Une cible se nomme déjà « {name} »',
  'error.endpointTaken': 'Une cible pointe déjà vers {user}@{host}:{port}',
  'error.nameTakenShort': 'Ce nom de cible est déjà pris',
  'error.endpointTakenOther': 'Une autre cible pointe déjà vers cet hôte',
  'error.badRange':
    'Plage de ports invalide : {start}-{end}. La borne basse doit précéder la borne haute.',
  /**
   * Les deux formes françaises sont identiques, et c'est voulu : la phrase
   * d'origine écrit « déploiement(s) actif(s) » plutôt que de s'accorder, et
   * l'aide des cibles la cite mot pour mot. L'anglais, lui, s'accorde.
   */
  'error.liveDeployments': {
    one: 'Cette cible porte {count} déploiement(s) actif(s). Détruisez-les avant de la supprimer.',
    other:
      'Cette cible porte {count} déploiement(s) actif(s). Détruisez-les avant de la supprimer.',
  },
  'error.pastDeployments': {
    one: "Cette cible ne porte plus rien en marche, mais garde {count} déploiement(s) dans l'historique, et l'historique ne se supprime pas tout seul. Purgez-les depuis l'écran Déploiements, puis reprenez.",
    other:
      "Cette cible ne porte plus rien en marche, mais garde {count} déploiement(s) dans l'historique, et l'historique ne se supprime pas tout seul. Purgez-les depuis l'écran Déploiements, puis reprenez.",
  },
  'error.jobNoId': "La tâche n'a pas reçu d'identifiant",
  'error.runNotOwned': 'Cette exécution a été ouverte par une autre session.',
  'error.metricsTimeout':
    "Le relevé n'a pas abouti dans le délai imparti. Le worker est peut-être saturé.",
  'error.metricsFailed': 'Relevé impossible : {message}',
  'error.metricsUnreadable': 'Le worker a renvoyé un relevé illisible',
  'error.inventoryTimeout':
    "La cible n'a pas répondu dans le délai imparti. Vérifiez sa connexion (preflight).",
  'error.inventoryFailed': 'Inventaire impossible : {message}',
  'error.inventoryUnreadable': 'Le worker a renvoyé un inventaire illisible',
  'error.badWorkloadRef': 'Référence de charge illisible : « {ref} »',
  'error.workloadNotFound': 'Aucune charge « {ref} » sur « {name} »',
  /** Deux clés plutôt qu'un fragment interpolé : `msg()` est paresseux, la
   *  langue n'est connue qu'au moment de sérialiser la réponse. */
  'error.workloadManagedUpdate':
    "« {name} » est déployée par le panel : sa mise à jour est un redéploiement. Lancez-en un depuis la fiche de l'application, qui rejouera aussi les scans et l'historique.",
  'error.workloadManagedUpdateApp':
    "« {name} » est déployée par le panel (application « {app} ») : sa mise à jour est un redéploiement. Lancez-en un depuis la fiche de l'application, qui rejouera aussi les scans et l'historique.",
  'error.workloadManagedControl':
    "« {name} » est déployée par le panel : on ne l'arrête ni ne la démarre d'ici, sinon le panel la croirait toujours en marche. Passez par « Arrêter » ou « Démarrer » sur la page Supervision de l'application.",
} as const;

const en: Translated<typeof fr> = {
  'page.title': 'Targets',
  'page.description':
    'The machines the panel deploys to, reachable over SSH. Preflight decides what can run there — Docker, K3s, or neither.',
  'page.add': 'Add a target',
  'page.testAll': 'Test all',

  'chips.label': 'Filter by state',
  'chip.all': 'All',
  'chip.ok': 'Operational',
  'chip.degraded': 'Degraded',
  'chip.unreachable': 'Unreachable',
  'chip.unknown': 'Never checked',
  'filter.total': { one: '{count} target', other: '{count} targets' },

  'column.load': 'Load 24 h',
  'load.none': 'no readout over 24 h',
  'load.silent': 'silent since {time}',
  'gauge.load': 'load',
  'gauge.memory': 'mem',
  'gauge.disk': 'dsk',
  'table.hint.before': 'Click a row for the preview,',
  'table.hint.after': 'for the record',
  'row.more': 'More actions',
  'row.open': 'Open record',
  'row.preview': 'Preview of {name}',

  'toast.preflight.title': 'Preflight started on {name}',
  'toast.preflight.detail': 'Result in about ten seconds; the row shows the phase live.',
  'toast.preflightAll.title': {
    one: 'Preflight started on {count} target',
    other: 'Preflight started on {count} targets',
  },
  'toast.preflightAll.detail': 'States update as answers come in.',
  'toast.deleted': 'Target {name} deleted',
  'toast.created': 'Target {name} added',
  'toast.created.detail': 'Test the connection to learn what the machine can do.',

  'drawer.kind': 'Target',
  'drawer.tested': 'checked {ago}',
  'drawer.never': 'no preflight run yet',
  'drawer.alert.unreachable.title': 'Unreachable.',
  'drawer.alert.unreachable': 'The machine has not answered over SSH since {time}.',
  'drawer.alert.degraded.title': 'Preflight degraded.',
  'drawer.alert.degraded': 'Failing checks: {checks}.',
  'drawer.alert.unknown.title': 'Never checked.',
  'drawer.alert.unknown':
    'Nothing is touched on the machine before the first check. Run it to learn whether Docker or K3s are available.',
  'drawer.address': 'Address',
  'drawer.sudo': 'Elevation',
  'drawer.ports.used': { one: '{count} in use', other: '{count} in use' },
  'drawer.load': 'Load over 24 h',
  'drawer.load.aside': 'worst {worst}% · threshold {limit}%',
  'drawer.apps': 'Applications',
  'drawer.apps.none': 'No application deployed on this machine.',
  'drawer.delete.title': 'Delete this target',
  'drawer.delete.free': 'Removes the target and its encrypted key. Nothing changes on the machine.',

  'app.health.healthy': 'running',
  'app.health.unhealthy': 'answers badly',
  'app.health.unreachable': 'unreachable',
  'app.health.unknown': 'state unknown',

  'delete.title': 'Delete target {name}?',
  'delete.consequence.key': 'The target and its encrypted key are removed from the panel.',
  'delete.consequence.machine': 'Nothing changes on {host}: no container, file or firewall rule.',
  'delete.consequence.audit': 'The operation is written to the activity log.',
  'delete.confirm': 'Delete target',

  'empty.title': 'No target yet',
  'empty.hint':
    'Declare a machine with its SSH access, then run a preflight: the panel will find Docker, K3s and the scanners on it.',

  'filter.placeholder': 'Filter: name, host, description, label…',
  'filter.aria': 'Filter targets',
  'filter.showAll': 'Show all',
  'filter.count': {
    one: '{count} target of {total}',
    other: '{count} targets of {total}',
  },
  'filter.none': 'No target matches this filter.',

  'label.filter.on': 'Filter on {pair}',
  'label.filter.off': 'Drop the {pair} filter',

  'column.runtimes': 'Runtimes',
  'column.lastCheck': 'Last check',
  'table.timestamps': 'Timestamps in {timezone}.',


  'action.test': 'Test the connection',
  'action.testing': 'Testing…',
  'preflight.never': 'never',
  'phase.queued': 'queued…',
  'phase.waiting': 'waiting…',
  'phase.ssh': 'SSH connection…',
  'phase.done': 'done',
  'preflight.error.timeout': 'Preflight is not answering (timeout)',
  'preflight.error.poll': 'Cannot follow the job (HTTP {status})',
  'preflight.error.failed': 'Preflight failed',

  'status.unknown': 'never checked',
  'status.ok': 'operational',
  'status.degraded': 'degraded',
  'status.unreachable': 'unreachable',

  'nav.back': 'Targets',
  'new.description':
    'The panel will open an SSH session to this machine to deploy on it. The credential is encrypted in the database as soon as you save.',
  'card.connection': 'Connection',
  'new.card.description':
    'Saving touches nothing on the machine. Preflight — the connection, sudo, runtime and firewall check — is what opens it for the first time. It runs from “Test the connection”, and decides what will be deployable here.',

  'edit.title': 'Edit “{name}”',
  'edit.description':
    'These settings hold from the next connection on. Nothing already running on this machine is redeployed, and ports already reserved stay reserved even if you narrow the range. After changing the host, the account or the key, run a preflight again: until then the previous readout stands as it is.',
  'edit.card.description':
    'The credential is never prefilled: leave the field empty to keep the one already in the database.',

  'field.name': 'Name',
  'field.sshUser': 'SSH user',
  'field.host': 'Host',
  'field.port': 'Port',
  'field.authMethod': 'Authentication',
  'auth.key': 'Private key',
  'auth.password': 'Password',
  'field.sudoMethod': 'Sudo elevation',
  'sudo.nopasswd': 'sudo without a password',
  'sudo.password': 'sudo with a password',
  'field.description': 'Description',
  'description.placeholder': 'Acme’s hypervisor. Restarts outside 9am–7pm only.',
  'description.help': 'What this machine is for, and what to know before touching it. Optional.',
  'field.credential.key': 'SSH private key',
  'field.credential.password': 'Password',
  'credential.help':
    'Encrypted with AES-256-GCM before insertion. Never returned by the API, never logged.',
  'credential.help.edit': ' Leave it empty to keep the current credential.',
  'field.portRange': 'Publishable port range',
  'portRange.help':
    'What this machine’s firewall lets through. Every application deployed on Docker reserves one port in it, kept unique by the database.',
  'field.labels': 'Labels',
  'labels.help.before': 'One',
  'labels.help.pair': 'key=value',
  'labels.help.after':
    'pair per line. The color comes from the text: a label keeps the same hue everywhere, and none can take green, amber or red — those colors say a machine’s state, not its role.',
  'form.error.keyRequired': 'The private key is required.',
  'form.error.passwordRequired': 'The password is required.',
  'submit.create': 'Create the target',

  'detail.tabs': 'Record sections',
  'detail.tab.overview': 'Overview',
  'detail.tab.workloads': 'Workloads',
  'detail.tab.ports': 'Ports',
  'detail.tab.preflight': 'Preflight',
  'detail.tab.config': 'Configuration',
  'detail.more': 'More actions',
  'detail.preview': 'Preview in the list',
  'detail.delete': 'Delete target…',
  'readout.load': 'Load',
  'readout.memory': 'Memory',
  'readout.disk': 'Disk',
  'readout.uptime': 'Uptime',
  'readout.stable': 'stable',
  'readout.trend': '{value} pt',
  'readout.load.hint': {
    one: '{value}% of {count} core',
    other: '{value}% of {count} cores',
  },
  'readout.memory.hint': '{used} / {total} GiB used',
  'readout.disk.hint': '{free} GiB free on {path}',
  'readout.uptime.days': '{days} d {hours} h',
  'readout.uptime.hours': '{hours} h {minutes} min',
  'readout.none': 'no readout',
  'detail.runtimes.summary':
    'Last preflight on {date} ({timezone}), {ok} of {total} checks passed in {seconds} s.',
  'detail.runtimes.never': 'No preflight has run on this target yet.',
  'ports.sub': 'Range {min}–{max}, {free}',
  'ports.axis': {
    one: '{count} in use of {capacity} · {percent}%',
    other: '{count} in use of {capacity} · {percent}%',
  },
  'check.status.success': 'passed',
  'check.status.failed': 'failed',
  'check.status.skipped': 'skipped',
  'workload.remove.title': 'Remove {kind} {name} from this machine?',
  'workload.remove.image': 'Image: {image}.',
  'workload.remove.final': 'Removal is final: the workload cannot be restarted.',
  'workload.remove.volumes': 'Named volumes are kept.',
  'workload.update.title': 'Update {kind} {name}?',
  'workload.update.pull': 'Image {image} is pulled at its latest version.',
  'workload.update.recreate': 'The workload is recreated with the same configuration.',
  'workload.update.downtime': 'It will be briefly unavailable.',
  'label.link.title': 'Show targets carrying {pair}',
  'detail.runtimes.title': 'Available runtimes',
  'detail.config.title': 'Configuration',
  'value.auth.key': 'private key',
  'value.auth.password': 'password',
  'value.sudo.nopasswd': 'no password',
  'value.sudo.password': 'password required',
  'field.credential': 'Credential',
  'value.credential': 'encrypted in the database, never exposed',
  'field.portRangeShort': 'Port range',

  'ports.title': 'Allocated ports',
  'ports.range': 'Range {min}–{max}',
  'ports.used': {
    one: '{count} taken of {capacity}',
    other: '{count} taken of {capacity}',
  },
  'ports.free': { one: '{count} free', other: '{count} free' },
  'ports.empty': 'No port reserved on this target.',
  'ports.column.port': 'Port',
  'ports.column.application': 'Application',
  'ports.column.lastDeployment': 'Last deployment',
  'ports.column.reservedAt': 'Reserved on',
  'ports.outOfRange': 'out of range',
  'ports.freeSample': 'Next free ports: {list}',
  'ports.exhausted': 'No free port left in the range: widen it before deploying.',

  'firewall.unknown': 'Firewall state unknown — run a preflight.',
  'firewall.absent.badge': 'ufw missing',
  'firewall.absent.text': 'Nothing filters the published ports.',
  'firewall.inactive.badge': 'ufw inactive',
  'firewall.inactive.text':
    'Installed but off: the panel sets no rule in it and does not turn it on.',
  'firewall.active.badge': 'ufw active',
  'firewall.rules': {
    one: '{count} rule set by the panel.',
    other: '{count} rules set by the panel.',
  },

  'report.title': 'Preflight report',
  'report.none': 'No preflight has run on this target yet.',
  'report.unreachable': 'Target unreachable',
  'report.machine': 'Machine',
  'row.os': 'System',
  'row.kernel': 'Kernel',
  'row.latency': 'SSH latency',
  'row.sudo': 'sudo',
  'sudo.passwordRequired': 'password required',
  'sudo.unavailable': 'unavailable',
  'row.disk': 'Disk /',
  'disk.value': '{available} free of {size} ({percent}%)',
  'unit.gib': 'GiB',
  'row.memory': 'Memory',
  'memory.value': '{available} MiB available of {total}',
  'row.tools': 'Tools',
  'row.compose': 'Docker Compose',
  'row.readyNodes': 'Ready nodes',
  'runtime.unavailable': '✗ unavailable',
  'report.checks.title': 'Checks',
  'report.checks.description':
    'Every check stands alone: one failure does not invalidate the others.',
  'column.check': 'Check',

  'workloads.title': 'What runs on this machine',
  'workloads.subtitle': 'Inventory taken live on the machine, by the worker.',
  'workloads.count': { one: '{count} workload', other: '{count} workloads' },
  'workloads.managed': {
    one: '{count} of them deployed by the panel',
    other: '{count} of them deployed by the panel',
  },
  'workloads.readout': 'readout from {date}',
  'workloads.loading': 'Asking the machine…',
  'workloads.unavailable': 'Inventory unavailable.',
  'workloads.empty': 'Nothing runs on this machine.',
  'workloads.runtimeError': '{runtime} had nothing to say: {error}',
  'workloads.error.http': 'Inventory failed (HTTP {status})',
  'workloads.error.plain': 'Inventory failed',
  'workloads.error.silent':
    'The machine refused the operation without saying why. The log above carries the worker’s raw output; “Refresh” gives back the machine’s real state.',

  'state.running': 'running',
  'state.restarting': 'restarting',
  'state.exited': 'stopped',
  'state.paused': 'paused',
  'state.created': 'created',
  'state.unknown': 'unknown',

  'progress.running': 'running',
  'progress.done': 'done',
  'progress.failed': 'failed',
  'progress.waiting': 'waiting for the worker…',

  'column.workload': 'Workload',
  'column.origin': 'Origin',
  'column.image': 'Image',
  'column.ports': 'Ports',
  'column.createdAt': 'Created on',
  'origin.panel': 'panel',
  'origin.outside': 'outside the panel',
  'workloads.managedNotice': 'managed by the panel — deploy it from there',
  'action.update': 'Update',
  'action.more': 'Actions on “{name}”',
  'action.start': 'Start',
  'action.stop': 'Stop',
  'action.restart': 'Restart',
  'action.logs': 'Log',
  'action.exec': 'Console',
  'workload.menu.managed': 'Managed by the panel',
  'workload.menu.managedApp': 'Managed by the panel · {app}',
  'workload.stop.title': 'Stop {kind} “{name}”?',
  'workload.stop.signal': 'The process gets a stop signal and twenty seconds to exit cleanly.',
  'workload.stop.unreachable': 'Whatever it serves stops answering until it starts again.',
  'workload.stop.keep':
    'Its configuration and volumes stay in place: “Start” brings it back as it was.',
  'workload.restart.title': 'Restart {kind} “{name}”?',
  'workload.restart.same': 'Same image, same configuration: only the process restarts.',
  'run.logs.kind': 'Log',
  'run.logs.note':
    'The last lines the workload wrote. A read, not a stream: “Read again” fetches them anew. Every read is recorded in the audit log.',
  'run.logs.tail': 'Lines to read',
  'run.logs.refresh': 'Read again',
  'run.logs.empty': 'The workload wrote nothing.',
  'run.exec.kind': 'Console',
  'run.exec.note':
    'One command at a time, run under sh -c inside the workload, without an interactive terminal, two minutes at most. Each one is recorded in the audit log with its exit code — never its output.',
  'run.exec.label': 'Command',
  'run.exec.placeholder': 'e.g. ls -la /data — ↑ for history',
  'run.exec.submit': 'Run',
  'run.exec.clear': 'Clear',
  'run.exec.empty': 'No command yet.',
  'run.exec.exit': 'exit code {code}',
  'run.exec.timeout': 'interrupted after {seconds} s',
  'run.exec.notRunning': '“{name}” is not running: start it to run a command inside.',
  'run.truncated': 'output cut at {max} lines',
  'run.streamError': 'Live stream unavailable.',
  'image.unknown': 'unknown',

  'workload.kind.container': 'container',
  'workload.kind.pod': 'pod',
  'workload.kind.deployment': 'deployment',
  'workload.kind.statefulset': 'statefulset',
  'workload.kind.daemonset': 'daemonset',


  'error.notFound': 'Target “{id}” not found',
  'error.nameTaken': 'A target is already named “{name}”',
  'error.endpointTaken': 'A target already points to {user}@{host}:{port}',
  'error.nameTakenShort': 'That target name is taken',
  'error.endpointTakenOther': 'Another target already points to this host',
  'error.badRange': 'Invalid port range: {start}-{end}. The low bound must come first.',
  'error.liveDeployments': {
    one: 'This target carries {count} live deployment. Destroy it before deleting the target.',
    other: 'This target carries {count} live deployments. Destroy them before deleting the target.',
  },
  'error.pastDeployments': {
    one: 'Nothing runs on this target any more, but {count} deployment stays in its history, and history does not delete itself. Purge it from the Deployments screen, then come back.',
    other:
      'Nothing runs on this target any more, but {count} deployments stay in its history, and history does not delete itself. Purge them from the Deployments screen, then come back.',
  },
  'error.jobNoId': 'The job got no ID',
  'error.runNotOwned': 'This run was opened by another session.',
  'error.metricsTimeout': 'The readout did not finish in time. The worker may be saturated.',
  'error.metricsFailed': 'Readout failed: {message}',
  'error.metricsUnreadable': 'The worker returned an unreadable readout',
  'error.inventoryTimeout':
    'The target did not answer in time. Check its connection (preflight).',
  'error.inventoryFailed': 'Inventory failed: {message}',
  'error.inventoryUnreadable': 'The worker returned an unreadable inventory',
  'error.badWorkloadRef': 'Unreadable workload reference: “{ref}”',
  'error.workloadNotFound': 'No workload “{ref}” on “{name}”',
  'error.workloadManagedUpdate':
    '“{name}” is deployed by the panel: updating it means redeploying it. Start a deployment from the application page — it replays the scans and the history too.',
  'error.workloadManagedUpdateApp':
    '“{name}” is deployed by the panel (application “{app}”): updating it means redeploying it. Start a deployment from the application page — it replays the scans and the history too.',
  'error.workloadManagedControl':
    '“{name}” is deployed by the panel: it is neither stopped nor started from here, or the panel would still believe it runs. Use “Stop” or “Start” on the application’s Supervision page.',
};

export const targets = { fr, en };
