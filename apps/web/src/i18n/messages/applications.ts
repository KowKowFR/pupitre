import type { Translated } from '@pupitre/core';

/**
 * Le catalogue d'applications — la liste, la fiche, ses secrets, sa timeline de
 * versions, la création (formulaire et génération), la suppression en cascade,
 * et les refus de toutes ces routes.
 *
 * ── Ce qui n'est pas traduit, et pourquoi ───────────────────────────────────
 * `AppSpec` est un nom propre : il ne se traduit ni ne se met au pluriel. Les
 * **noms de champs** du format (`services`, `env`, `secrets`, `ingress`) sont
 * des clés JSON, pas des mots — les traduire produirait une spec que Zod
 * refuserait. Les noms de secrets, de services, d'images et de fournisseurs
 * viennent des données : ils s'affichent tels quels.
 *
 * Certaines phrases sont coupées en deux clés (`.before` / `.after`) : ce sont
 * celles qui entourent un `<code>` ou un `<strong>` dans le JSX. Une clé par
 * fragment est laide mais honnête — l'alternative, du balisage dans le
 * dictionnaire, obligerait le traducteur à écrire du HTML.
 */
const fr = {
  // ── Liste ───────────────────────────────────────────────────────────────
  'page.title': 'Applications',
  'page.description':
    'Une application est une AppSpec : une description neutre, qui ne connaît ni Docker ni Kubernetes. Le driver la traduit en compose.yml ou en manifests au moment du déploiement.',
  'action.new': 'Nouvelle application',
  'action.catalog': 'Depuis le catalogue',

  'column.inService': 'En service sur',
  'inService.never': 'jamais déployée',
  'row.deploy': 'Déployer',
  'row.more': "Plus d'actions",
  'row.open': 'Ouvrir la fiche',
  'row.delete': 'Supprimer…',

  'new.left.sub': "Décrivez ou collez, puis relisez avant d'enregistrer.",
  'new.review.sub.proposal': 'Proposition du modèle, à valider',
  'new.review.sub.manual': 'Relecture de la spec saisie',
  'new.review.empty': 'La relecture apparaît dès que la spec est un JSON lisible.',
  'new.json.sub.generated': 'générée, éditable',
  'new.json.sub.manual': 'à coller ou à écrire',
  'new.json.tab.hint':
    'Collez ou écrivez la spec dans le bloc JSON ; la relecture se met à jour à chaque frappe.',
  'new.deploy.title': 'Déployer dans la foulée',
  'new.deploy.note': 'La spec est validée, puis un run est enfilé.',
  'new.deploy.noteSave': 'La spec est validée, puis enregistrée au catalogue.',
  'generate.again': 'Régénérer',
  'generate.done': 'Spec générée.',

  'detail.more': "Plus d'actions",
  'redeploy.dialog.title': 'Redéployer {slug} {version} sur {target} ?',
  'redeploy.consequence.frozen': "L'AppSpec figée à l'époque est rejouée telle quelle.",
  'redeploy.consequence.current': "L'application actuelle n'est pas utilisée.",
  'redeploy.consequence.run': 'Un nouveau run est enfilé ; il se suit dans Déploiements.',
  'redeploy.toast': 'Redéploiement de {slug} {version} enfilé',
  'secrets.regenerate.dialog.title': 'Régénérer {name} ?',
  'secrets.regenerate.consequence.draw': 'Une nouvelle valeur est tirée au sort et chiffrée en base.',
  'secrets.regenerate.consequence.next': "Elle ne prend effet qu'au prochain déploiement.",
  'secrets.regenerate.consequence.data':
    "Les données déjà écrites avec l'ancienne valeur (le volume d'une base, par exemple) ne la connaîtront pas.",
  'secrets.regenerate.action': 'Régénérer',
  'secrets.delete.dialog.title': 'Supprimer la valeur de {name} ?',
  'secrets.delete.consequence.gone': 'La valeur chiffrée est effacée définitivement.',
  'secrets.delete.consequence.orphan': "Aucun service de l'AppSpec courante ne la réclame.",
  'table.count': {
    one: '{count} application au catalogue',
    other: '{count} applications au catalogue',
  },
  'table.legend': 'Service exposé en badge plein',
  'drawer.kind': 'Application',
  'drawer.run': 'Ce qui va tourner',
  'drawer.exposed': 'exposé',
  'drawer.service.port': 'port {port}',
  'drawer.service.internal': 'port {port} interne',
  'drawer.service.health': 'santé GET {path} toutes les {interval} s, {retries} essais',
  'drawer.service.depends': 'dépend de : {list}',
  'drawer.service.volumes': 'volumes : {list}',
  'drawer.service.secrets': 'secrets : {list}',
  'drawer.service.replicas': '{count} réplicas',
  'drawer.ingress': 'ingress : {host} → {service}',
  'drawer.inService': 'En service',
  'drawer.inService.since': '{state} · déployée {ago}',
  'drawer.deploy': 'Déployer',
  'drawer.deploy.target': 'Cible',
  'drawer.deploy.runtime': 'Runtime',
  'drawer.deploy.runtime.help': 'Seuls les runtimes vus par le preflight de la cible sont proposés.',
  'drawer.deploy.noTarget':
    'Aucune cible prête : lancez un preflight depuis Cibles pour savoir ce que chaque machine sait faire.',
  'drawer.deploy.action': 'Déployer {version}',
  'runtime.docker': 'Docker Compose',
  'runtime.k3s': 'K3s',
  'health.healthy': 'en marche',
  'health.unhealthy': 'répond mal',
  'health.unreachable': 'injoignable',
  'health.unknown': 'état inconnu',
  'toast.deployed': 'Déploiement de {slug} v{version} enfilé',
  'toast.deployed.detail': 'Run #{number} · suivez-le dans Déploiements.',
  'toast.follow': 'Suivre',
  'toast.deleted': 'Application {slug} supprimée',
  'toast.created': 'Application {name} enregistrée',
  'toast.created.detail': 'Relisez-la et déployez-la depuis son aperçu.',

  'empty.title': 'Aucune application',
  'empty.hint':
    "Décrivez une application — services, image, port exposé — ou laissez l'IA en proposer une AppSpec que vous relirez avant de déployer.",

  'lifecycle.autoRollback': "Rollback automatique en cas d'échec",
  'lifecycle.autoRollback.on':
    'Un healthcheck raté ramène la version précédente, si elle existe.',
  'lifecycle.note':
    'Le runtime se choisit par cible : une cible Docker reçoit un compose.yml, une cible K3s des manifests. L’AppSpec, elle, est la même.',
  'lifecycle.scope':
    'Un healthcheck raté ramène la version précédente, si elle existe. Vaut pour les déploiements lancés depuis cet écran.',

  'column.application': 'Application',
  'column.services': 'Services',
  'column.exposure': 'Exposition',
  'exposure.allocatedPort': 'port alloué',
  'action.deploy': 'Déployer',
  'action.sending': 'Envoi…',


  // ── Suppression ─────────────────────────────────────────────────────────
  'delete.title': 'Supprimer « {slug} » ?',
  'delete.title.cascade': 'Détruire et supprimer « {slug} » ?',
  'delete.live': 'Déploiements vivants',
  'delete.description.abandoned':
    'Une cible n’a pas pu être nettoyée. Lisez ce qui va rester dessus.',
  'delete.description.blockers':
    'L’application tourne encore. Elle sera démontée sur ses cibles avant d’être effacée.',
  'delete.description.history': 'L’application ne porte plus que de l’historique.',
  'delete.loading': 'Lecture de ce qui bloque…',
  'delete.readFailed': 'Lecture impossible',
  'delete.historyOnly': {
    one: 'Rien ne tourne : {count} déploiement d’historique sera effacé, avec leurs étapes, leurs logs et leurs scans.',
    other:
      'Rien ne tourne : {count} déploiements d’historique seront effacés, avec leurs étapes, leurs logs et leurs scans.',
  },
  'delete.blockers.lines': { one: '{count} ligne', other: '{count} lignes' },
  'delete.blockers': {
    one: '{count} déploiement encore en place. Il sera détruit sur sa cible, puis tout l’historique ({lines}) sera effacé.',
    other:
      '{count} déploiements encore en place. Ils seront détruits sur leurs cibles, puis tout l’historique ({lines}) sera effacé.',
  },
  'delete.blocker.on': 'sur {target}',
  'delete.blocker.port': ' · port {port}',
  'delete.releasedPorts': {
    one: 'Port rendu à leur cible : {list}.',
    other: 'Ports rendus à leur cible : {list}.',
  },
  'delete.cascadePermissions.before': 'La cascade exige en plus ',
  'delete.cascadePermissions.after':
    '. Demandez ces permissions, ou détruisez les déploiements un par un depuis l’écran des déploiements.',
  'delete.abandoned': {
    one: '{count} déploiement n’a pas pu être détruit. Forcer n’arrête rien sur la machine : ce qui suit continuera de tourner, sans que le panel sache le nommer.',
    other:
      '{count} déploiements n’ont pas pu être détruits. Forcer n’arrête rien sur la machine : ce qui suit continuera de tourner, sans que le panel sache le nommer.',
  },
  'delete.destroyed': 'Déjà détruit : {list}.',
  'delete.destroyed.entry': 'v{version} sur {target}',
  'delete.auditNote':
    'Ces informations partent dans les logs d’activité avant l’effacement — c’est la seule trace qui permettra de finir le ménage à la main.',
  'delete.retype.before': 'Retapez ',
  'delete.retype.after': ' pour débloquer le forçage.',
  'delete.progress.force': 'Effacement forcé…',
  'delete.progress.cascade': 'Destruction sur les cibles…',
  'delete.job.silent': 'La tâche ne répond plus. Consultez les logs d’activité.',
  'delete.job.failed': 'tâche en échec',
  'delete.job.progress': 'Tâche {state}…',
  'delete.action.force': 'Forcer l’effacement',
  'delete.action.cascade': 'Détruire et supprimer',

  // ── Fiche ───────────────────────────────────────────────────────────────
  'detail.spec.title': 'AppSpec courante',
  'detail.spec.description':
    'Ce que le prochain déploiement utilisera. Les versions déjà déployées gardent la leur, figée.',
  'detail.spec.byPort': 'exposition par port alloué',

  'versions.title': 'Historique des versions',
  'versions.empty':
    'Chaque déploiement fige son AppSpec au moment où il part : c’est ce qui permet de rejouer une version telle qu’elle était, sur la même cible ou sur une autre.',
  'versions.count': {
    one: '{count} déploiement, du plus récent au plus ancien. Chaque version garde son AppSpec figée : c’est ce qui la rend rejouable.',
    other:
      '{count} déploiements, du plus récent au plus ancien. Chaque version garde son AppSpec figée : c’est ce qui la rend rejouable.',
  },
  'versions.never':
    "Cette application n'a jamais été déployée. Le bouton « Déployer » de la liste des applications en produit la première version ; elle apparaîtra ici.",
  'redeploy.confirm':
    "Redéployer « {slug} » dans sa version {version} sur {target} ?\n\nL'AppSpec figée à l'époque sera rejouée telle quelle — l'application actuelle n'est pas utilisée.",
  'redeploy.chosenTarget': 'la cible choisie',
  'redeploy.action': 'Redéployer cette version',
  'redeploy.impossible': 'Aucune AppSpec figée sur ce déploiement : rien à rejouer.',

  // ── Secrets ─────────────────────────────────────────────────────────────
  /** Le titre exact que cherchent les vérifications d'intégration. */
  'secrets.title': 'Secrets',
  'secrets.description.1':
    "L'AppSpec ne déclare que des noms ; les valeurs vivent chiffrées en base, sous",
  'secrets.description.2':
    ", et ne sont déchiffrées que par le worker au moment du rendu. Elles sont attachées à l'application, pas au déploiement : un redéploiement réutilise la même valeur, sans quoi le volume d'une base déjà initialisée deviendrait inaccessible.",
  'secrets.description.3': "Un nom peut reprendre la valeur d'un autre",
  'secrets.description.4':
    "— l'application et sa base attendent souvent le même mot de passe sous deux noms différents. Il n'y a alors qu'une valeur, et un seul endroit où la changer.",
  'secrets.none': 'Cette application ne déclare aucun secret.',
  'secrets.badge.alias': 'alias',
  'secrets.badge.set': 'définie',
  'secrets.badge.generatedAtDeploy': 'générée au déploiement',
  'secrets.badge.generated': 'générée',
  'secrets.badge.provided': 'saisie',
  'secrets.badge.undeclared': 'plus déclarée',
  'secrets.badge.pending': 'à appliquer',
  'secrets.pending.title': {
    one: '{count} secret modifié depuis le dernier déploiement.',
    other: '{count} secrets modifiés depuis le dernier déploiement.',
  },
  'secrets.pending.body':
    'Les valeurs se rendent au déploiement : ce qui tourne utilise encore les anciennes. Déployez à nouveau pour les appliquer.',
  'secrets.claimedBy': 'réclamée par ',
  'secrets.orphan':
    "aucun service de l'AppSpec courante ne la réclame — conservée tant qu'elle n'est pas supprimée à la main",
  'secrets.aliasOf.before': 'reprend la valeur de ',
  'secrets.aliasOf.after': ' — aucune valeur propre, aucune ligne en base',
  'secrets.readAs': 'lue aussi sous',
  'secrets.editOnRoot': 'se modifie sur « {name} »',
  'secrets.newValue': 'nouvelle valeur',
  'secrets.replace': 'Remplacer',
  'secrets.setNow': 'Saisir maintenant',
  'secrets.regenerate.label': 'Régénérer {name}',
  'secrets.delete.label': 'Supprimer {name}',

  // ── Création ────────────────────────────────────────────────────────────
  'new.description':
    "Rien n'est touché sur une machine tant qu'aucune cible n'est choisie. Le prompt et la spec générée sont conservés avec l'application.",
  'new.card.title': 'AppSpec',
  'new.card.description':
    "Décrivez l'application et laissez le modèle proposer une spec, ou collez directement un JSON. Dans les deux cas, la proposition s'affiche avant enregistrement, et Zod valide avant que quoi que ce soit n'atteigne la base.",

  'tab.fromPrompt': 'Depuis une description',
  'tab.fromJson': 'Depuis un JSON',
  'tab.fromCompose': 'Depuis un docker-compose',
  'new.secrets.title': 'Valeurs des secrets',
  'new.secrets.help':
    'Laissez vide pour que Pupitre génère une valeur, chiffrée. Saisissez celles qui viennent d’ailleurs : une clé d’API, le mot de passe d’une base existante. Elles partent avec le premier déploiement.',
  'new.secrets.placeholder': 'générée si vide',
  'compose.label': 'Contenu du docker-compose.yml',
  'compose.help':
    'Collez le fichier, ou choisissez-le. Rien n’est enregistré avant « Enregistrer » : la conversion propose une AppSpec, à relire.',
  'compose.placeholder': 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "8080:80"',
  'compose.file': 'Choisir un fichier…',
  'compose.fileTooLarge': 'Fichier trop lourd ({size} Ko) : 256 Ko au plus.',
  'compose.name': 'Nom de l’application',
  'compose.name.help':
    'Facultatif. Sinon celui du fichier (clé « name »), ou « imported-app ».',
  'compose.convert': 'Convertir en AppSpec',
  'compose.converting': 'Conversion…',
  'compose.empty': 'Collez un docker-compose.yml, ou choisissez un fichier.',
  'compose.summary': 'AppSpec proposée : {services}. Relisez-la ci-dessous, puis enregistrez.',
  'compose.services': { one: '{count} service', other: '{count} services' },
  'compose.count.blocking': { one: '{count} point bloquant', other: '{count} points bloquants' },
  'compose.count.warning': { one: '{count} approximation', other: '{count} approximations' },
  'compose.count.info': { one: '{count} information', other: '{count} informations' },
  'compose.lead.blocking':
    'À régler avant de déployer — l’application ne fonctionnera probablement pas en l’état :',
  'compose.lead.warning': 'Traduit par approximation — à vérifier :',
  'compose.lead.info': 'Ignoré à dessein, parce que Pupitre en décide :',
  'compose.invalid': 'L’AppSpec ne passe pas encore la validation : corrigez-la dans l’éditeur.',
  'compose.slugTaken':
    'Une application « {name} » existe déjà : changez le nom ci-dessus, ou dans l’AppSpec.',
  'compose.file.scope': 'fichier',
  'new.review.sub.imported': 'Traduite du docker-compose, à relire',
  'new.json.sub.imported': 'traduite, éditable',

  'ai.disabled.lead':
    "La génération par IA est désactivée : aucune clé d'API {provider} n'est configurée sur ce panel",
  'ai.disabled.envVar': '(ni dans Paramètres → Intelligence artificielle, ni via',
  'ai.disabled.tail': ". L'onglet « Depuis un JSON » reste disponible.",

  'form.prompt.label': "Décrivez l'application",
  'form.prompt.placeholder': 'Génère une application GLPI avec sa base de données',
  'form.prompt.help':
    "Le modèle produit du JSON validé par Zod — jamais une commande. Rien n'est enregistré ni déployé : la spec s'affiche ci-dessous, à relire et à corriger.",
  'form.hint.language': 'Langage',
  'form.hint.database': 'Base de données',
  'form.hint.runtime': 'Runtime visé',
  'form.hint.runtime.any': 'indifférent',
  'form.hint.note':
    "Le runtime n'entre jamais dans l'AppSpec — elle ne connaît ni Docker ni Kubernetes. Il ne sert qu'à dimensionner.",

  'generate.action': 'Générer',
  'generate.pending': 'Génération…',
  'generate.info': '{provider} · {model} — {seconds} s',
  'generate.info.tokens': ', {tokens} tokens',
  'generate.info.retried': ', après une relance sur erreurs de validation',
  'generate.info.slugTaken': ' — ⚠ une application porte déjà ce nom',
  'generate.failed': 'Génération impossible',

  'form.fieldError': '{field} : {message}',
  'form.invalidJson': 'JSON invalide : {message}',
  'form.unreadable': 'illisible',
  'form.savedButDeployFailed':
    "L'application « {name} » a bien été enregistrée, mais le déploiement a échoué : {message}",

  'review.label': 'Ce qui va tourner',
  'form.appSpec.label': 'AppSpec (JSON)',
  'form.insertExample': 'Insérer un exemple',
  'form.origin.note':
    "Le prompt et la spec générée seront conservés avec l'application, à côté de la version que vous validez.",
  'form.deployTarget.none': 'ne pas déployer maintenant',
  'form.runtime.label': 'Runtime',
  'form.submit.pending': 'Validation…',
  'form.submit.saveAndDeploy': "Enregistrer et déployer l'application",
  'form.submit.save': "Enregistrer l'application",
  'form.submit.empty': "Écrivez, collez ou générez d'abord une spec.",

  // ── Relecture de la spec, avant enregistrement ──────────────────────────
  'review.unnamed': '(sans nom)',
  'review.services': { one: '{count} service', other: '{count} services' },
  'review.exposed': 'exposé',
  'review.port': 'port {port}',
  'review.health': 'santé : {value}',
  'review.health.port': 'port {port}',
  'review.health.get': 'GET {path}',
  'review.health.interval': ', toutes les {seconds} s',
  'review.health.retries': ', {retries} essais',
  'review.dependsOn': 'dépend de : {list}',
  'review.secrets': 'secrets : {list}',
  'review.volumes': 'volumes :',
  'review.ingress': 'ingress : {host} → {service}{tls}',
  'review.ingress.noHost': 'sans nom de domaine',
  'review.thirdParty.lead': {
    one: 'Image publiée par un tiers :',
    other: 'Images publiées par un tiers :',
  },
  'review.thirdParty.tail':
    ". Le panel ne vérifie pas qu'un tag existe avant le déploiement — un tag inexistant fait échouer la mise en ligne au téléchargement de l'image. Vérifiez-le sur le registre avant de déployer.",
  'review.floating.lead': 'Tag flottant : ',
  'review.floating.tail':
    '. Un redéploiement ne redonnera pas forcément la même version. Figez-le si le projet publie un tag de version.',
  'review.declaredSecrets.lead': {
    one: 'Cette spec déclare {count} secret —',
    other: 'Cette spec déclare {count} secrets —',
  },
  'review.declaredSecrets.mid': '. Seuls leurs',
  'review.declaredSecrets.names': 'noms',
  'review.declaredSecrets.tail':
    ' sont dans la spec. À l’enregistrement, Pupitre génère une valeur pour chacun, chiffrée et jamais réaffichée ; un alias reprend la valeur de son secret. Une valeur venue d’ailleurs se saisit ensuite sur la fiche de l’application.',

  // ── Refus des routes ────────────────────────────────────────────────────
  'error.notFound': 'Application « {id} » introuvable',
  'row.imagesOutdated': {
    one: '{count} image à mettre à jour',
    other: '{count} images à mettre à jour',
  },
  'row.imagesNewer': 'nouvelle version',
  'images.title': 'Images',
  'images.description.never':
    'Pas encore comparées à leur registre. La vérification passe toutes les six heures ; « Vérifier maintenant » n’attend pas.',
  'images.description.checked':
    'Comparées à leur registre {ago}. Vérification automatique toutes les six heures.',
  'images.built':
    'Les images de cette application sont construites sur la cible : il n’y a pas de registre à interroger.',
  'images.check': 'Vérifier maintenant',
  'images.checking': 'Vérification…',
  'images.check.queued': 'Vérification des images demandée',
  'images.outdated.title': {
    one: '{count} image republiée depuis le déploiement',
    other: '{count} images republiées depuis le déploiement',
  },
  'images.outdated.body':
    'Le tag désigne aujourd’hui un autre contenu que celui qui tourne — souvent un correctif de sécurité de l’image de base. Redéployer la version en service le récupère, sans rien changer d’autre.',
  'images.onTarget': 'sur {target}',
  'images.digests': 'en service {running} · registre {latest}',
  'images.newer': '{tag} disponible',
  'images.major': '{tag} (majeure)',
  'images.status.current': 'à jour',
  'images.status.outdated': 'republiée',
  'images.status.unknown': 'non vérifiable',
  'images.status.pinned': 'épinglée par digest',
  'images.error.unauthorized': 'Image privée : le registre refuse une lecture anonyme.',
  'images.error.not_found': 'Le registre ne connaît pas ce tag.',
  'images.error.rate_limited': 'Quota du registre atteint — nouvel essai au prochain passage.',
  'images.error.unreachable': 'Registre injoignable depuis le worker.',
  'images.error.unexpected': 'Réponse inattendue du registre.',
  'images.error.target_unreachable': 'Cible injoignable : impossible de lire ce qui tourne.',
  'images.error.not_running': 'Aucun conteneur en marche pour ce service.',
  'images.update': 'Mettre à jour',
  'images.update.title': 'Redéployer « {slug} » sur « {target} » ?',
  'images.update.same': 'La version en service repart telle quelle : même AppSpec, mêmes secrets.',
  'images.update.pull':
    'Les images sont tirées à nouveau ; seuls les services dont le contenu a changé redémarrent.',
  'images.update.pipeline':
    'Le pipeline habituel s’applique : scans, healthcheck, retour automatique en cas d’échec.',
  'images.update.toast': '« {slug} » redéployée sur « {target} »',
  'error.jobNoId': "La tâche n'a pas reçu d'identifiant",
  'error.slugTaken': 'Une application « {name} » existe déjà',
  'error.secretNotDeclared':
    '« {name} » n’est pas un secret que cette AppSpec déclare (ou c’est un alias, qui reprend la valeur d’un autre).',
  'error.enqueueFailed': "La tâche n'a pas reçu d'identifiant",
  'error.deploymentEntry': 'v{version} sur {target}',
  'error.liveDeployments': {
    one: "« {slug} » a {count} déploiement encore en place : {list}. Supprimez-la en cascade (POST {path}/cascade) — elle le détruira sur sa cible avant d'effacer l'application —, ou détruisez-le d'abord.",
    other:
      "« {slug} » a {count} déploiements encore en place : {list}. Supprimez-la en cascade (POST {path}/cascade) — elle les détruira sur leurs cibles avant d'effacer l'application —, ou détruisez-les d'abord.",
  },
  'error.jobNotFound': 'Aucune tâche « {jobId} » dans la queue ops',
  'error.jobOtherApplication': 'La tâche « {jobId} » ne concerne pas cette application',
  'error.deploymentsInProgress': {
    one: "{count} déploiement de « {slug} » est en cours : {list}. Attendez qu'il se termine — le forçage ne s'applique pas à un déploiement en vol.",
    other:
      "{count} déploiements de « {slug} » sont en cours : {list}. Attendez qu'ils se terminent — le forçage ne s'applique pas à un déploiement en vol.",
  },
  'error.confirmationRequired': {
    one: "Le forçage abandonne {count} charge sur sa machine sans l'arrêter : {list}. Recopiez « {slug} » dans « confirm » pour confirmer.",
    other:
      'Le forçage abandonne {count} charges sur leurs machines sans les arrêter : {list}. Recopiez « {slug} » dans « confirm » pour confirmer.',
  },
  'error.abandonEntry': '{workspace} sur {target} ({host}{port})',
  'error.abandonPort': ', port {port}',

  'error.versionNotFound': 'Version « {id} » introuvable',
  'error.versionOtherApplication':
    "Cette version appartient à une autre application : impossible de la rejouer ici.",
  'error.versionNoSpec':
    "Le déploiement #{version} n'a pas d'AppSpec figée : il a été enregistré avant que le panel ne conserve la spec de chaque run, et il n'y a donc rien à rejouer. Déployez la version courante de l'application à la place.",
  'error.targetNotFound': 'Cible « {id} » introuvable',
  /** Voir `deployments.ts` : « aucun » est une clé, pas une variable. */
  'error.versionRuntimeUnavailable':
    "Le runtime « {runtime} » de cette version n'est pas disponible sur « {target} ». Runtimes exploitables : {available}.",
  'error.versionRuntimeUnavailable.none':
    "Le runtime « {runtime} » de cette version n'est pas disponible sur « {target} ». Runtimes exploitables : aucun.",

  'error.aiNoKey':
    "La génération par IA est désactivée : aucune clé d'API {provider} n'est configurée sur ce panel. Renseignez-la dans Paramètres → Intelligence artificielle{envVar}.",
  'error.aiEnvVar': ', ou via {variable}',
  'error.aiDisabled': 'La génération par IA est désactivée dans les paramètres de cette instance.',

  'error.secretAlias':
    "« {name} » reprend la valeur de « {root} » : il n'a pas de valeur propre. Modifiez « {root} », les deux noms suivront.",
  'error.secretDeclared':
    "« {name} » est déclaré par l'AppSpec courante : retirez-le de la spec avant de supprimer sa valeur.",
  'error.secretNotFound': 'Secret « {name} » introuvable',
} as const;

const en: Translated<typeof fr> = {
  'page.title': 'Applications',
  'page.description':
    'An application is an AppSpec: a neutral description that knows neither Docker nor Kubernetes. The driver turns it into a compose.yml or manifests at deploy time.',
  'action.new': 'New application',
  'action.catalog': 'From the catalog',

  'column.inService': 'In service on',
  'inService.never': 'never deployed',
  'row.deploy': 'Deploy',
  'row.more': 'More actions',
  'row.open': 'Open record',
  'row.delete': 'Delete…',

  'new.left.sub': 'Describe or paste, then review before saving.',
  'new.review.sub.proposal': 'Model proposal, to be validated',
  'new.review.sub.manual': 'Review of the entered spec',
  'new.review.empty': 'The review shows up as soon as the spec is readable JSON.',
  'new.json.sub.generated': 'generated, editable',
  'new.json.sub.manual': 'to paste or write',
  'new.json.tab.hint': 'Paste or write the spec in the JSON block; the review updates on every keystroke.',
  'new.deploy.title': 'Deploy right away',
  'new.deploy.note': 'The spec is validated, then a run is queued.',
  'new.deploy.noteSave': 'The spec is validated, then saved to the catalog.',
  'generate.again': 'Regenerate',
  'generate.done': 'Spec generated.',

  'detail.more': 'More actions',
  'redeploy.dialog.title': 'Redeploy {slug} {version} on {target}?',
  'redeploy.consequence.frozen': 'The AppSpec frozen at the time is replayed as is.',
  'redeploy.consequence.current': 'The current application is not used.',
  'redeploy.consequence.run': 'A new run is queued; follow it in Deployments.',
  'redeploy.toast': 'Redeployment of {slug} {version} queued',
  'secrets.regenerate.dialog.title': 'Regenerate {name}?',
  'secrets.regenerate.consequence.draw': 'A new value is drawn at random and encrypted in the database.',
  'secrets.regenerate.consequence.next': 'It only takes effect at the next deployment.',
  'secrets.regenerate.consequence.data':
    'Data already written with the old value (a database volume, for instance) will not know it.',
  'secrets.regenerate.action': 'Regenerate',
  'secrets.delete.dialog.title': 'Delete the value of {name}?',
  'secrets.delete.consequence.gone': 'The encrypted value is erased for good.',
  'secrets.delete.consequence.orphan': 'No service of the current AppSpec claims it.',
  'table.count': {
    one: '{count} application in the catalog',
    other: '{count} applications in the catalog',
  },
  'table.legend': 'Exposed service as a solid badge',
  'drawer.kind': 'Application',
  'drawer.run': 'What will run',
  'drawer.exposed': 'exposed',
  'drawer.service.port': 'port {port}',
  'drawer.service.internal': 'internal port {port}',
  'drawer.service.health': 'health GET {path} every {interval} s, {retries} tries',
  'drawer.service.depends': 'depends on: {list}',
  'drawer.service.volumes': 'volumes: {list}',
  'drawer.service.secrets': 'secrets: {list}',
  'drawer.service.replicas': '{count} replicas',
  'drawer.ingress': 'ingress: {host} → {service}',
  'drawer.inService': 'In service',
  'drawer.inService.since': '{state} · deployed {ago}',
  'drawer.deploy': 'Deploy',
  'drawer.deploy.target': 'Target',
  'drawer.deploy.runtime': 'Runtime',
  'drawer.deploy.runtime.help': "Only the runtimes seen by the target's preflight are offered.",
  'drawer.deploy.noTarget':
    'No target is ready: run a preflight from Targets to learn what each machine can do.',
  'drawer.deploy.action': 'Deploy {version}',
  'runtime.docker': 'Docker Compose',
  'runtime.k3s': 'K3s',
  'health.healthy': 'running',
  'health.unhealthy': 'answers badly',
  'health.unreachable': 'unreachable',
  'health.unknown': 'state unknown',
  'toast.deployed': 'Deployment of {slug} v{version} queued',
  'toast.deployed.detail': 'Run #{number} · follow it in Deployments.',
  'toast.follow': 'Follow',
  'toast.deleted': 'Application {slug} deleted',
  'toast.created': 'Application {name} saved',
  'toast.created.detail': 'Review it and deploy it from its preview.',

  'empty.title': 'No application',
  'empty.hint':
    'Describe an application — services, image, exposed port — or let the AI propose an AppSpec for you to review before deploying.',

  'lifecycle.autoRollback': 'Roll back automatically on failure',
  'lifecycle.autoRollback.on':
    'A failed healthcheck brings back the previous version, if there is one.',
  'lifecycle.note':
    'The runtime is picked per target: a Docker target gets a compose.yml, a K3s target manifests. The AppSpec stays the same.',
  'lifecycle.scope':
    'A failed healthcheck brings back the previous version, if there is one. Applies to deployments started from this screen.',

  'column.application': 'Application',
  'column.services': 'Services',
  'column.exposure': 'Exposure',
  'exposure.allocatedPort': 'allocated port',
  'action.deploy': 'Deploy',
  'action.sending': 'Sending…',


  'delete.title': 'Delete “{slug}”?',
  'delete.title.cascade': 'Destroy and delete “{slug}”?',
  'delete.live': 'Live deployments',
  'delete.description.abandoned':
    'One target could not be cleaned up. Read what will stay on it.',
  'delete.description.blockers':
    'The application is still running. It will be taken down on its targets before it is erased.',
  'delete.description.history': 'The application carries nothing but history.',
  'delete.loading': 'Reading what stands in the way…',
  'delete.readFailed': 'Cannot read',
  'delete.historyOnly': {
    one: 'Nothing is running: {count} history deployment will be erased, with its steps, its logs and its scans.',
    other:
      'Nothing is running: {count} history deployments will be erased, with their steps, their logs and their scans.',
  },
  'delete.blockers.lines': { one: '{count} row', other: '{count} rows' },
  'delete.blockers': {
    one: '{count} deployment still in place. It will be destroyed on its target, then the whole history ({lines}) will be erased.',
    other:
      '{count} deployments still in place. They will be destroyed on their targets, then the whole history ({lines}) will be erased.',
  },
  'delete.blocker.on': 'on {target}',
  'delete.blocker.port': ' · port {port}',
  'delete.releasedPorts': {
    one: 'Port returned to its target: {list}.',
    other: 'Ports returned to their targets: {list}.',
  },
  'delete.cascadePermissions.before': 'A cascade also requires ',
  'delete.cascadePermissions.after':
    '. Ask for these permissions, or destroy the deployments one by one from the deployments screen.',
  'delete.abandoned': {
    one: '{count} deployment could not be destroyed. Forcing stops nothing on the machine: what follows keeps running, with no name the panel can give it.',
    other:
      '{count} deployments could not be destroyed. Forcing stops nothing on the machine: what follows keeps running, with no names the panel can give them.',
  },
  'delete.destroyed': 'Already destroyed: {list}.',
  'delete.destroyed.entry': 'v{version} on {target}',
  'delete.auditNote':
    'This goes into the activity log before the erase — it is the only trace left to finish the cleanup by hand.',
  'delete.retype.before': 'Retype ',
  'delete.retype.after': ' to unlock forcing.',
  'delete.progress.force': 'Forced erase…',
  'delete.progress.cascade': 'Destroying on the targets…',
  'delete.job.silent': 'The job stopped answering. Check the activity log.',
  'delete.job.failed': 'job failed',
  'delete.job.progress': 'Job {state}…',
  'delete.action.force': 'Force the erase',
  'delete.action.cascade': 'Destroy and delete',

  'detail.spec.title': 'Current AppSpec',
  'detail.spec.description':
    'What the next deployment will use. Versions already deployed keep theirs, frozen.',
  'detail.spec.byPort': 'exposed on an allocated port',

  'versions.title': 'Version history',
  'versions.empty':
    'Each deployment freezes its AppSpec as it leaves: that is what lets you replay a version as it was, on the same target or on another.',
  'versions.count': {
    one: '{count} deployment, newest first. Each version keeps its AppSpec frozen: that is what makes it replayable.',
    other:
      '{count} deployments, newest first. Each version keeps its AppSpec frozen: that is what makes it replayable.',
  },
  'versions.never':
    'This application has never been deployed. The “Deploy” button in the applications list produces its first version; it will show up here.',
  'redeploy.confirm':
    'Redeploy “{slug}” at version {version} on {target}?\n\nThe AppSpec frozen back then will be replayed as it is — the current application is not used.',
  'redeploy.chosenTarget': 'the chosen target',
  'redeploy.action': 'Redeploy this version',
  'redeploy.impossible': 'No frozen AppSpec on this deployment: nothing to replay.',

  'secrets.title': 'Secrets',
  'secrets.description.1':
    'The AppSpec declares names only; the values live encrypted in the database, under',
  'secrets.description.2':
    ', and the worker decrypts them only when it renders. They belong to the application, not to the deployment: a redeploy reuses the same value, otherwise the volume of an already initialized database would become unreadable.',
  'secrets.description.3': 'One name can take another’s value',
  'secrets.description.4':
    '— an application and its database often expect the same password under two different names. There is then one value, and one place to change it.',
  'secrets.none': 'This application declares no secret.',
  'secrets.badge.alias': 'alias',
  'secrets.badge.set': 'set',
  'secrets.badge.generatedAtDeploy': 'generated at deploy',
  'secrets.badge.generated': 'generated',
  'secrets.badge.provided': 'entered',
  'secrets.badge.undeclared': 'no longer declared',
  'secrets.badge.pending': 'to apply',
  'secrets.pending.title': {
    one: '{count} secret changed since the last deployment.',
    other: '{count} secrets changed since the last deployment.',
  },
  'secrets.pending.body':
    'Values are rendered at deployment: what runs still uses the old ones. Deploy again to apply them.',
  'secrets.claimedBy': 'claimed by ',
  'secrets.orphan':
    'no service of the current AppSpec claims it — kept until someone deletes it by hand',
  'secrets.aliasOf.before': 'takes the value of ',
  'secrets.aliasOf.after': ' — no value of its own, no row in the database',
  'secrets.readAs': 'also read as',
  'secrets.editOnRoot': 'edited on “{name}”',
  'secrets.newValue': 'new value',
  'secrets.replace': 'Replace',
  'secrets.setNow': 'Set it now',
  'secrets.regenerate.label': 'Regenerate {name}',
  'secrets.delete.label': 'Delete {name}',

  'new.description':
    'Nothing is touched on a machine until a target is chosen. The prompt and the generated spec are kept with the application.',
  'new.card.title': 'AppSpec',
  'new.card.description':
    'Describe the application and let the model propose a spec, or paste JSON straight in. Either way the proposal shows before it is saved, and Zod validates before anything reaches the database.',

  'tab.fromPrompt': 'From a description',
  'tab.fromJson': 'From JSON',
  'tab.fromCompose': 'From docker-compose',
  'new.secrets.title': 'Secret values',
  'new.secrets.help':
    'Leave empty for Pupitre to generate an encrypted value. Enter those that come from elsewhere: an API key, an existing database password. They go out with the first deployment.',
  'new.secrets.placeholder': 'generated if empty',
  'compose.label': 'docker-compose.yml content',
  'compose.help':
    'Paste the file, or pick it. Nothing is saved before “Save”: the conversion proposes an AppSpec, to review.',
  'compose.placeholder': 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "8080:80"',
  'compose.file': 'Pick a file…',
  'compose.fileTooLarge': 'File too large ({size} KB): 256 KB at most.',
  'compose.name': 'Application name',
  'compose.name.help': 'Optional. Otherwise the file’s (“name” key), or “imported-app”.',
  'compose.convert': 'Convert to AppSpec',
  'compose.converting': 'Converting…',
  'compose.empty': 'Paste a docker-compose.yml, or pick a file.',
  'compose.summary': 'Proposed AppSpec: {services}. Review it below, then save.',
  'compose.services': { one: '{count} service', other: '{count} services' },
  'compose.count.blocking': { one: '{count} blocking point', other: '{count} blocking points' },
  'compose.count.warning': { one: '{count} approximation', other: '{count} approximations' },
  'compose.count.info': { one: '{count} note', other: '{count} notes' },
  'compose.lead.blocking':
    'To settle before deploying — the application will probably not work as is:',
  'compose.lead.warning': 'Translated by approximation — to check:',
  'compose.lead.info': 'Ignored on purpose, because Pupitre decides:',
  'compose.invalid': 'The AppSpec does not pass validation yet: fix it in the editor.',
  'compose.slugTaken':
    'An application “{name}” already exists: change the name above, or in the AppSpec.',
  'compose.file.scope': 'file',
  'new.review.sub.imported': 'Translated from docker-compose, to review',
  'new.json.sub.imported': 'translated, editable',

  'ai.disabled.lead':
    'AI generation is off: no {provider} API key is configured on this panel',
  'ai.disabled.envVar': '(neither under Settings → Artificial intelligence, nor through',
  'ai.disabled.tail': '. The “From JSON” tab stays available.',

  'form.prompt.label': 'Describe the application',
  'form.prompt.placeholder': 'Generate a GLPI application with its database',
  'form.prompt.help':
    'The model produces JSON validated by Zod — never a command. Nothing is saved or deployed: the spec shows below, to read and fix.',
  'form.hint.language': 'Language',
  'form.hint.database': 'Database',
  'form.hint.runtime': 'Target runtime',
  'form.hint.runtime.any': 'no preference',
  'form.hint.note':
    'The runtime never enters the AppSpec — it knows neither Docker nor Kubernetes. It only helps with sizing.',

  'generate.action': 'Generate',
  'generate.pending': 'Generating…',
  'generate.info': '{provider} · {model} — {seconds} s',
  'generate.info.tokens': ', {tokens} tokens',
  'generate.info.retried': ', after one retry on validation errors',
  'generate.info.slugTaken': ' — ⚠ an application already goes by this name',
  'generate.failed': 'Generation failed',

  'form.fieldError': '{field}: {message}',
  'form.invalidJson': 'Invalid JSON: {message}',
  'form.unreadable': 'unreadable',
  'form.savedButDeployFailed':
    'Application “{name}” was saved, but the deployment failed: {message}',

  'review.label': 'What will run',
  'form.appSpec.label': 'AppSpec (JSON)',
  'form.insertExample': 'Insert an example',
  'form.origin.note':
    'The prompt and the generated spec are kept with the application, next to the version you approve.',
  'form.deployTarget.none': 'do not deploy now',
  'form.runtime.label': 'Runtime',
  'form.submit.pending': 'Validating…',
  'form.submit.saveAndDeploy': 'Save and deploy the application',
  'form.submit.save': 'Save the application',
  'form.submit.empty': 'Write, paste or generate a spec first.',

  'review.unnamed': '(unnamed)',
  'review.services': { one: '{count} service', other: '{count} services' },
  'review.exposed': 'exposed',
  'review.port': 'port {port}',
  'review.health': 'health: {value}',
  'review.health.port': 'port {port}',
  'review.health.get': 'GET {path}',
  'review.health.interval': ', every {seconds} s',
  'review.health.retries': ', {retries} tries',
  'review.dependsOn': 'depends on: {list}',
  'review.secrets': 'secrets: {list}',
  'review.volumes': 'volumes:',
  'review.ingress': 'ingress: {host} → {service}{tls}',
  'review.ingress.noHost': 'no domain name',
  'review.thirdParty.lead': {
    one: 'Image published by a third party:',
    other: 'Images published by third parties:',
  },
  'review.thirdParty.tail':
    '. The panel does not check that a tag exists before deploying — a tag that does not exist fails the rollout when the image is pulled. Check it on the registry first.',
  'review.floating.lead': 'Floating tag: ',
  'review.floating.tail':
    '. A redeploy will not necessarily bring back the same version. Pin it if the project publishes a version tag.',
  'review.declaredSecrets.lead': {
    one: 'This spec declares {count} secret —',
    other: 'This spec declares {count} secrets —',
  },
  'review.declaredSecrets.mid': '. Only their',
  'review.declaredSecrets.names': 'names',
  'review.declaredSecrets.tail':
    ' are in the spec. On save, Pupitre generates a value for each, encrypted and never shown again; an alias takes its secret’s value. A value from elsewhere is entered afterwards on the application page.',

  'error.notFound': 'Application “{id}” not found',
  'row.imagesOutdated': {
    one: '{count} image to update',
    other: '{count} images to update',
  },
  'row.imagesNewer': 'new version',
  'images.title': 'Images',
  'images.description.never':
    'Not yet compared with their registry. The check runs every six hours; “Check now” does not wait.',
  'images.description.checked':
    'Compared with their registry {ago}. Checked automatically every six hours.',
  'images.built': 'This application’s images are built on the target: there is no registry to ask.',
  'images.check': 'Check now',
  'images.checking': 'Checking…',
  'images.check.queued': 'Image check requested',
  'images.outdated.title': {
    one: '{count} image republished since the deployment',
    other: '{count} images republished since the deployment',
  },
  'images.outdated.body':
    'The tag now points to other content than what runs — often a security fix to the base image. Redeploying the running version fetches it, nothing else changes.',
  'images.onTarget': 'on {target}',
  'images.digests': 'running {running} · registry {latest}',
  'images.newer': '{tag} available',
  'images.major': '{tag} (major)',
  'images.status.current': 'up to date',
  'images.status.outdated': 'republished',
  'images.status.unknown': 'cannot check',
  'images.status.pinned': 'pinned by digest',
  'images.error.unauthorized': 'Private image: the registry refuses anonymous reads.',
  'images.error.not_found': 'The registry does not know this tag.',
  'images.error.rate_limited': 'Registry quota reached — retried on the next pass.',
  'images.error.unreachable': 'Registry unreachable from the worker.',
  'images.error.unexpected': 'Unexpected answer from the registry.',
  'images.error.target_unreachable': 'Target unreachable: cannot read what runs.',
  'images.error.not_running': 'No running container for this service.',
  'images.update': 'Update',
  'images.update.title': 'Redeploy “{slug}” on “{target}”?',
  'images.update.same': 'The running version goes out as is: same AppSpec, same secrets.',
  'images.update.pull': 'Images are pulled again; only the services whose content changed restart.',
  'images.update.pipeline':
    'The usual pipeline applies: scans, healthcheck, automatic rollback on failure.',
  'images.update.toast': '“{slug}” redeployed on “{target}”',
  'error.jobNoId': 'The job got no ID',
  'error.slugTaken': 'An application “{name}” already exists',
  'error.secretNotDeclared':
    '“{name}” is not a secret this AppSpec declares (or it is an alias, which takes another’s value).',
  'error.enqueueFailed': 'The job got no ID',
  'error.deploymentEntry': 'v{version} on {target}',
  'error.liveDeployments': {
    one: '“{slug}” has {count} deployment still in place: {list}. Delete it as a cascade (POST {path}/cascade) — that destroys it on its target before erasing the application — or destroy it first.',
    other:
      '“{slug}” has {count} deployments still in place: {list}. Delete it as a cascade (POST {path}/cascade) — that destroys them on their targets before erasing the application — or destroy them first.',
  },
  'error.jobNotFound': 'No job “{jobId}” in the ops queue',
  'error.jobOtherApplication': 'Job “{jobId}” does not belong to this application',
  'error.deploymentsInProgress': {
    one: '{count} deployment of “{slug}” is running: {list}. Wait for it to finish — forcing does not apply to a deployment in flight.',
    other:
      '{count} deployments of “{slug}” are running: {list}. Wait for them to finish — forcing does not apply to a deployment in flight.',
  },
  'error.confirmationRequired': {
    one: 'Forcing abandons {count} workload on its machine without stopping it: {list}. Retype “{slug}” into “confirm” to confirm.',
    other:
      'Forcing abandons {count} workloads on their machines without stopping them: {list}. Retype “{slug}” into “confirm” to confirm.',
  },
  'error.abandonEntry': '{workspace} on {target} ({host}{port})',
  'error.abandonPort': ', port {port}',

  'error.versionNotFound': 'Version “{id}” not found',
  'error.versionOtherApplication':
    'This version belongs to another application: it cannot be replayed here.',
  'error.versionNoSpec':
    'Deployment #{version} has no frozen AppSpec: it was recorded before the panel kept each run’s spec, so there is nothing to replay. Deploy the application’s current version instead.',
  'error.targetNotFound': 'Target “{id}” not found',
  'error.versionRuntimeUnavailable':
    'Runtime “{runtime}” of this version is not available on “{target}”. Usable runtimes: {available}.',
  'error.versionRuntimeUnavailable.none':
    'Runtime “{runtime}” of this version is not available on “{target}”. No runtime is usable there.',

  'error.aiNoKey':
    'AI generation is off: no {provider} API key is configured on this panel. Set one under Settings → Artificial intelligence{envVar}.',
  'error.aiEnvVar': ', or through {variable}',
  'error.aiDisabled': 'AI generation is off in this instance’s settings.',

  'error.secretAlias':
    '“{name}” takes the value of “{root}”: it has none of its own. Change “{root}” and both names follow.',
  'error.secretDeclared':
    '“{name}” is declared by the current AppSpec: take it out of the spec before deleting its value.',
  'error.secretNotFound': 'Secret “{name}” not found',
};

export const applications = { fr, en };
