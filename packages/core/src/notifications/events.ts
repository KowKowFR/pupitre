import { DEFAULT_UI_LANGUAGE, renderMessage, type Translated, type UiLanguage, type Vars } from '../i18n.js';
import {
  notificationDigestItemSchema,
  type NotificationDigestItem,
} from './digest.js';
import {
  notificationMessageSchema,
  type NotificationField,
  type NotificationMessage,
  type NotificationSeverity,
} from './message.js';
import { SIGNUP_ROLE } from '../permissions.js';

/**
 * Ce qui mérite d'être notifié — et rien d'autre.
 *
 * ── Pourquoi si peu d'événements ────────────────────────────────────────────
 * Le journal d'audit enregistre une soixantaine d'actions. En notifier ne
 * serait-ce que le quart rendrait la boîte de réception inutilisable en une
 * journée, et la première chose que ferait l'opérateur serait de couper la
 * fonctionnalité — c'est-à-dire de ne plus être prévenu de *rien*. Sept
 * événements sont retenus, tous répondant à la même question : « faut-il que
 * quelqu'un se lève ? »
 *
 *   deployment.failed         une mise en ligne n'a pas abouti
 *   deployment.scan_blocked   une image vulnérable a été arrêtée avant la mise en ligne
 *   deployment.rolled_back    le panel est revenu tout seul à la version d'avant
 *   security.two_factor_reset une protection de compte a été levée
 *   security.role_changed     quelqu'un a gagné ou perdu des droits
 *   security.signup_pending   un compte s'est inscrit et attend qu'on lui choisisse un rôle
 *   security.api_token_created un jeton d'API a été créé : un accès qui agit sans navigateur
 *   security.host_key_changed une cible présente une autre clé d'hôte : connexion refusée
 *   monitor.down              un site supervisé est tombé, panne confirmée
 *   monitor.recovered         ce site est revenu
 *   image.update.available    une image déployée a été republiée, ou dépassée
 *   backup.failed             une sauvegarde n'a pas abouti
 *   route.down                un domaine ne répond plus à travers son reverse proxy
 *   route.recovered           ce domaine répond de nouveau
 *
 * Sont écartés, volontairement : les succès (un déploiement qui marche ne
 * réveille personne), les refus de permission (bavards et déjà tracés) et les
 * relevés périodiques.
 *
 * ── Pourquoi la supervision entre ici, alors qu'elle avait son webhook ───────
 * Les sondes savaient déjà alerter, mais chacune vers **son** webhook, réglé
 * sonde par sonde. Un site pouvait donc tomber sans que personne ne l'apprenne,
 * sur une instance qui a pourtant un canal Discord qui marche. Le passage par
 * le catalogue leur donne gratuitement ce que la couche de notifications sait
 * déjà faire : les quatre protocoles, le regroupement des rafales, les résumés
 * nommés, le rejeu par canal. Le webhook par sonde, lui, reste — voir plus bas.
 *
 * ── Ce que la supervision n'envoie PAS ──────────────────────────────────────
 * Une sonde passe entre `healthy`, `unhealthy` et `unreachable`. Toutes les
 * bascules ne se valent pas, et c'est la machine à états qui tranche, pas ce
 * fichier : `nextMonitorState()` n'annonce une transition qu'après
 * `failureThreshold` échecs consécutifs (ouverture) ou `recoveryThreshold`
 * succès consécutifs (fermeture), et **aucune** quand une sonde déjà en panne
 * passe de « répond mal » à « injoignable ». L'hystérésis existe donc en amont
 * de l'audit : un rebond n'écrit pas d'entrée, donc ne produit pas d'événement.
 * Il n'y a rien à refiltrer ici, et surtout rien à réinventer.
 *
 * ── Pourquoi un seul `monitor.down` et non deux ─────────────────────────────
 * Séparer « répond mal » d'« injoignable » donnerait deux événements, donc deux
 * groupes de regroupement, donc deux résumés pour une même panne
 * d'infrastructure qui produit un mélange de 503 et de connexions refusées. La
 * nature de la panne appartient au *contenu* du message et de la ligne de
 * résumé, pas à la clé — même arbitrage que `notificationDigestGroupKey()`.
 *
 * ── Pourquoi la source est le journal d'audit ───────────────────────────────
 * Ces sept événements passent **déjà** par `logAudit()`, le point d'entrée
 * unique de la traçabilité. Les redécrire à la main sur chaque site d'émission
 * demanderait de modifier le pipeline de déploiement, deux routes
 * d'administration et le worker — et de recommencer au prochain événement. En
 * dérivant d'une entrée d'audit, la correspondance « ce qui s'est passé » →
 * « ce qu'on envoie » tient dans cette seule table, et rien en amont ne bouge.
 *
 * Les deux derniers venus le démontrent : la supervision écrivait déjà
 * `monitor.down` / `monitor.recovered` dans `audit_logs`. Les brancher sur les
 * canaux n'a demandé **aucune** ligne dans `apps/worker/src/monitors` en dehors
 * d'un enrichissement de la charge utile d'audit — deux entrées ici ont suffi.
 *
 * Corollaire assumé : un événement qui n'est pas audité n'est pas notifiable.
 * C'est une bonne contrainte — un incident qui ne laisse pas de trace ne
 * devrait pas exister.
 */

export const NOTIFICATION_EVENT_KEYS = [
  'deployment.failed',
  'deployment.scan_blocked',
  'deployment.rolled_back',
  'security.two_factor_reset',
  'security.role_changed',
  'security.signup_pending',
  'security.api_token_created',
  'security.host_key_changed',
  'monitor.down',
  'monitor.recovered',
  'target.threshold.breached',
  'target.threshold.cleared',
  'image.update.available',
  'backup.failed',
  'route.down',
  'route.recovered',
] as const;

export type NotificationEventKey = (typeof NOTIFICATION_EVENT_KEYS)[number];

/**
 * Les mots d'une alerte, dans les deux langues.
 *
 * ── Pourquoi le dictionnaire est ici et non dans `apps/web` ─────────────────
 * Personne n'est devant l'écran quand ce texte s'écrit. Il n'y a ni session, ni
 * requête, ni composant : c'est le worker qui compose, à trois heures du matin,
 * en réaction à une entrée d'audit. Le dictionnaire vit donc à côté de ce qu'il
 * décrit, comme le veut la règle posée dans `i18n.ts` — les dictionnaires
 * d'interface dans le panel, ceux du domaine à côté du domaine.
 *
 * ── D'où vient la langue ────────────────────────────────────────────────────
 * De `settings.locale`, par `languageOf()`, résolue par l'appelant et descendue
 * dans `NotificationRenderContext`. `packages/core` ne dépend pas de
 * `@pupitre/db` et ne la lira donc jamais lui-même. C'est la même contrainte
 * qui a fait passer `panelUrl` et `instance` par ce contexte.
 *
 * ── Ce qui ne se traduit pas ────────────────────────────────────────────────
 * Les clés d'événement, les noms d'action d'audit, les identifiants de
 * ressource, les slugs et les URL. Ce sont des données, pas des phrases.
 */
const fr = {
  // ── vocabulaire partagé ────────────────────────────────────────────────
  'actor.label': 'Déclenché par',
  'actor.system': 'le système (tâche planifiée ou worker)',
  'yes': 'oui',
  'no': 'non',
  'roles.none': 'aucun rôle',

  'duration.seconds': '{value} s',
  'duration.minutes': '{value} min',
  'duration.hours': '{value} h',
  'duration.hoursMinutes': '{value} h {rest}',
  'duration.days': '{value} j',

  // ── étiquettes de champ ────────────────────────────────────────────────
  'field.deployment': 'Déploiement',
  'field.step': 'Étape',
  'field.error': 'Erreur',
  'field.verdict': 'Verdict',
  'field.attemptedVersion': 'Version tentée',
  'field.restoredVersion': 'Version restaurée',
  'field.reason': 'Raison',
  'field.url': 'URL',
  'field.account': 'Compte',
  'field.name': 'Nom',
  'field.selfReset': 'Réinitialisation par soi-même',
  'field.closedSessions': 'Sessions fermées',
  'field.before': 'Avant',
  'field.after': 'Après',
  'field.probe': 'Sonde',
  'field.target': 'Cible',
  'field.observation': 'Constat',
  'field.consecutiveFailures': 'Échecs consécutifs',
  'field.incident': 'Incident',
  'field.was': 'Était',
  'field.outageDuration': 'Durée de la panne',
  'field.machine': 'Machine',
  'field.metric': 'Métrique',
  'field.threshold': 'Seuil',
  'field.consecutiveReadouts': 'Relevés consécutifs',
  'field.thresholdOrigin': 'Origine du seuil',
  'field.peakValue': 'Pire valeur atteinte',
  'field.breachDuration': 'Durée du dépassement',
  'field.clearedBy': 'Levée par',

  // ── vocabulaire de la supervision ──────────────────────────────────────
  'monitor.verdict.unreachable': 'injoignable',
  'monitor.verdict.unhealthy': 'répond mal',
  'monitor.verdict.healthy': 'sain',
  'monitor.verdict.unknown': 'état inconnu',
  'monitor.sentence.unreachable': 'est injoignable',
  'monitor.sentence.unhealthy': 'répond mal',
  'monitor.sentence.healthy': 'répond normalement',
  'monitor.sentence.unknown': 'est dans un état inconnu',
  'monitor.summary': 'site {name}',
  'monitor.summaryWithTarget': 'site {name} — {target}',

  // ── deployment.failed ──────────────────────────────────────────────────
  'deployment.failed.label': 'Déploiement en échec',
  'deployment.failed.description': 'Une mise en ligne s’est arrêtée sur une étape en erreur.',
  'deployment.failed.rationale':
    'L’application visée n’est pas à jour, et personne ne le sait tant que quelqu’un ' +
    'n’ouvre pas l’écran des déploiements.',
  'deployment.failed.title': 'Déploiement en échec',
  'deployment.failed.body':
    'Le déploiement {id} s’est arrêté{step}. ' +
    'La version précédente, si elle tournait, tourne toujours.',
  'deployment.failed.bodyStep': ' sur l’étape « {step} »',
  'deployment.failed.summaryStep': 'étape « {step} »',
  'deployment.summary': 'déploiement {id}',

  // ── deployment.scan_blocked ────────────────────────────────────────────
  'deployment.scan_blocked.label': 'Mise en ligne bloquée par un scan',
  'deployment.scan_blocked.description':
    'L’analyse de sécurité a trouvé une vulnérabilité au-delà du seuil et a empêché la mise en ligne.',
  'deployment.scan_blocked.rationale':
    'C’est le seul cas où le panel refuse volontairement de faire ce qu’on lui demande. ' +
    'Sans message, l’opérateur croit à une panne et relance en boucle.',
  'deployment.scan_blocked.title': 'Mise en ligne bloquée par l’analyse de sécurité',
  'deployment.scan_blocked.body':
    'Le déploiement {id} a été arrêté à l’étape d’analyse : une ' +
    'vulnérabilité atteint le seuil de blocage configuré pour l’instance. Rien n’a été ' +
    'mis en ligne.',

  // ── deployment.rolled_back ─────────────────────────────────────────────
  'deployment.rolled_back.label': 'Retour arrière automatique',
  'deployment.rolled_back.description':
    'Le healthcheck a échoué et le panel est revenu seul à la version précédente.',
  'deployment.rolled_back.rationale':
    'L’état de production a changé sans que personne ne l’ait demandé. C’est exactement ' +
    'le genre de chose qu’on ne veut pas découvrir trois jours plus tard.',
  'deployment.rolled_back.title': 'Retour arrière automatique',
  'deployment.rolled_back.body':
    'La version {tried} n’a pas répondu au healthcheck. Le panel est ' +
    'revenu seul à la version {restored}, qui répond. ' +
    'La mise en ligne est à reprendre.',

  // ── security.two_factor_reset ──────────────────────────────────────────
  'security.two_factor_reset.label': 'Second facteur réinitialisé',
  'security.two_factor_reset.description': 'Un administrateur a levé le second facteur d’un compte.',
  'security.two_factor_reset.rationale':
    'C’est le geste qui rouvre un compte protégé. Il est légitime la plupart du temps — ' +
    'et c’est précisément pour ça qu’il doit être vu par quelqu’un d’autre que celui qui le fait.',
  'security.two_factor_reset.title': 'Second facteur réinitialisé',
  'security.two_factor_reset.body':
    'Le second facteur du compte {account} a été levé. ' +
    'Ses sessions ouvertes ont été fermées, ses appareils de confiance oubliés.',
  'security.two_factor_reset.bySelf': 'par lui-même',
  'security.two_factor_reset.bySystem': 'par le système',

  // ── security.role_changed ──────────────────────────────────────────────
  'security.role_changed.label': 'Rôle d’un utilisateur modifié',
  'security.role_changed.description': 'Un compte a changé de rôle, donc de permissions.',
  'security.role_changed.rationale':
    'Une élévation de droits est la porte d’entrée de tout le reste. Elle doit être ' +
    'visible immédiatement, pas au prochain audit trimestriel.',
  'security.role_changed.title': 'Rôle d’un utilisateur modifié',
  'security.role_changed.body': 'Le compte {account} passe de « {before} » à « {after} ».',
  'security.summary': 'compte {account}',

  // ── security.signup_pending ────────────────────────────────────────────
  'security.signup_pending.label': 'Inscription en attente d’un rôle',
  'security.signup_pending.description':
    'Un compte s’est créé par l’inscription publique ; il n’a accès à rien tant qu’on ne lui a pas choisi de rôle.',
  'security.signup_pending.rationale':
    'Sans ce message, la personne attend devant un panel vide, et personne ne sait qu’elle est là.',
  'security.signup_pending.title': 'Nouvelle inscription : {account}',
  'security.signup_pending.body':
    'Le compte {account} vient d’être créé par l’inscription publique. Il n’a accès à rien ' +
    'tant qu’un administrateur ne lui a pas attribué de rôle.',
  'security.signup_pending.summary': 'en attente d’un rôle',

  // ── security.api_token_created ─────────────────────────────────────────
  'security.api_token_created.label': 'Jeton d’API créé',
  'security.api_token_created.description':
    'Quelqu’un a créé un jeton d’API : un accès qui agit en son nom, sans navigateur ni second facteur.',
  'security.api_token_created.rationale':
    'Un jeton fuit plus facilement qu’une session — dans un dépôt, un journal de CI. ' +
    'Le voir naître, c’est savoir qu’il existe le jour où il faudra le couper.',
  'security.api_token_created.title': 'Jeton d’API « {name} » créé',
  'security.api_token_created.body':
    'Le compte {account} a créé le jeton « {name} » : {permissions} permission(s), {applications}.',
  'security.api_token_created.allApplications': 'toutes les applications',
  'security.api_token_created.someApplications': '{count} application(s)',
  'security.api_token_created.noExpiry': 'sans échéance',
  'field.token': 'Jeton',
  'field.expires': 'Échéance',

  // ── security.host_key_changed ──────────────────────────────────────────
  'security.host_key_changed.label': 'Clé d’hôte d’une cible changée',
  'security.host_key_changed.description':
    'Une cible a présenté une autre clé SSH que celle retenue : Pupitre refuse de s’y connecter.',
  'security.host_key_changed.rationale':
    'Soit la machine a été réinstallée, soit une autre se fait passer pour elle. ' +
    'Dans les deux cas, plus rien n’y est déployé tant que quelqu’un n’a pas tranché.',
  'security.host_key_changed.title': 'Clé d’hôte changée sur « {machine} »',
  'security.host_key_changed.body':
    'La cible {machine} ({host}) a présenté une autre clé SSH que celle retenue. ' +
    'Pupitre refuse de s’y connecter. Si elle a été réinstallée, acceptez la nouvelle clé ' +
    'sur sa page ; sinon, cherchez qui se fait passer pour elle.',
  'security.host_key_changed.summary': 'cible {machine}',
  'field.expectedKey': 'Clé retenue',
  'field.presentedKey': 'Clé présentée',

  // ── monitor.down ───────────────────────────────────────────────────────
  'monitor.down.label': 'Site en panne',
  'monitor.down.description':
    'Une sonde a confirmé qu’un site ne répond plus comme attendu, après son seuil d’échecs consécutifs.',
  'monitor.down.rationale':
    'C’est le seul événement du catalogue qui parle de ce qui est **déjà en ligne**, et non ' +
    'de ce qu’on essaie d’y mettre. Un site tombé ne produit aucune autre trace : personne ' +
    'ne rafraîchit l’écran des sondes à trois heures du matin.',
  'monitor.down.title': 'Site en panne — {name}',
  'monitor.down.body':
    'La sonde « {name} » sur {target} {verdict}{detail}. ' +
    'La panne est confirmée{failures} — ce n’est pas un rebond isolé.',
  'monitor.down.bodyDetail': ' : {detail}',
  'monitor.down.bodyFailures': ' après {count} échecs consécutifs',
  'monitor.down.summaryDetail': '{verdict} — {detail}',

  // ── monitor.recovered ──────────────────────────────────────────────────
  'monitor.recovered.label': 'Site rétabli',
  'monitor.recovered.description':
    'Une sonde en panne est repassée au vert, après son seuil de succès consécutifs.',
  'monitor.recovered.rationale':
    'Seul « succès » du catalogue, et c’est assumé : il ne s’adresse qu’à quelqu’un qui a ' +
    'déjà reçu la panne. Une alerte sans son pendant oblige à aller vérifier à la main, ' +
    'c’est-à-dire exactement ce qu’on voulait éviter en installant des sondes.',
  'monitor.recovered.title': 'Site rétabli — {name}',
  'monitor.recovered.body':
    'La sonde « {name} » sur {target} répond de nouveau normalement. ' +
    'L’incident est refermé{duration}. ' +
    'Aucune action n’est attendue.',
  'monitor.recovered.bodyDuration': ' après {duration} de panne',
  'monitor.recovered.summaryDetail': 'rétabli après {duration} de panne',
  'monitor.recovered.summaryPlain': 'rétabli',

  // ── target.threshold.breached ──────────────────────────────────────────
  'target.threshold.breached.label': 'Seuil de machine franchi',
  'target.threshold.breached.description':
    'Une machine cible a dépassé un seuil de charge, de mémoire ou de disque, confirmé sur ' +
    'plusieurs relevés consécutifs.',
  'target.threshold.breached.rationale':
    'Un disque qui se remplit ne casse rien jusqu’au moment où il casse tout, et il ne casse ' +
    'pas seulement l’application qu’on regarde : il casse toutes celles que la machine porte. ' +
    'C’est le seul événement du catalogue qui prévient **avant** la panne plutôt qu’après.',
  'target.threshold.breached.title': 'Seuil franchi — {machine}',
  'target.threshold.breached.observation': 'seuil dépassé',
  'target.threshold.breached.summary': 'machine {machine} — {observation}',
  'target.threshold.breached.summaryDetail': '{observation} (seuil {limit} %)',
  'target.threshold.breached.body':
    'La machine « {machine} » a franchi un seuil de supervision : {observation}. ',
  'target.threshold.breached.bodyLimit': 'Le seuil est fixé à {limit} %. ',
  'target.threshold.breached.bodyReadouts':
    'Le dépassement est confirmé sur {count} relevé(s) consécutif(s) — ce n’est pas un pic isolé. ',
  'target.threshold.breached.bodyExposure':
    'Les applications déployées sur cette machine sont exposées, pas seulement celle qu’on surveille.',
  'target.threshold.percent': '{limit} %',

  // ── target.threshold.cleared ───────────────────────────────────────────
  'target.threshold.cleared.label': 'Seuil de machine rétabli',
  'target.threshold.cleared.description':
    'Une machine cible est repassée sous un seuil qu’elle avait franchi.',
  'target.threshold.cleared.rationale':
    'Le pendant du précédent, et pour la même raison qu’un site rétabli : sans lui, personne ' +
    'ne sait si l’alerte de la nuit est toujours d’actualité au matin.',
  'target.threshold.cleared.title': 'Seuil rétabli — {machine}',
  'target.threshold.cleared.metric': 'seuil',
  'target.threshold.cleared.observation': 'sous le seuil',
  'target.threshold.cleared.summary': 'machine {machine} — {metric} sous le seuil',
  'target.threshold.cleared.summaryDisabled':
    'le seuil a été désactivé, la machine n’a pas forcément changé',
  'target.threshold.cleared.bodyDisabled':
    'L’alerte sur « {machine} » ({metric}) est levée parce que le seuil ' +
    'a été désactivé, **pas** parce que la machine est repassée en dessous. Rien n’indique ' +
    'que la situation se soit améliorée.',
  'target.threshold.cleared.body':
    'La machine « {machine} » est repassée sous son seuil de {metric}. ',
  'target.threshold.cleared.bodyDuration': 'Le dépassement aura duré {duration}.',
  'target.threshold.cleared.byDisabled': 'désactivation du seuil',
  'target.threshold.cleared.byCrossed': 'retour sous le seuil',

  // ── image.update.available ─────────────────────────────────────────────
  'image.update.available.label': 'Mise à jour d’image disponible',
  'image.update.available.description':
    'Une image d’une application déployée a été republiée sous le même tag, ou une version ' +
    'plus récente de la même série est sortie.',
  'image.update.available.rationale':
    'Une image de base reçoit ses correctifs de sécurité par republication du même tag : ' +
    'sans redéploiement, l’application garde les failles corrigées depuis. Le panel vérifie ' +
    'toutes les six heures et n’annonce chaque nouveauté qu’une fois.',
  'image.update.available.title': 'Mise à jour d’image — {app}',
  'image.update.available.summary': '{app} sur {machine}',
  'image.update.available.summaryDetail': '{count} image(s)',
  'image.update.available.body': 'Du nouveau pour « {app} » sur « {machine} ». ',
  'image.update.available.bodyOutdated':
    'Republiée depuis le déploiement : {images}. Redéployer la version en service récupère ' +
    'le nouveau contenu, sans rien changer d’autre. ',
  'image.update.available.bodyNewer':
    'Version plus récente publiée : {images}. Changer de tag se fait dans l’AppSpec.',
  'field.application': 'Application',
  'field.images': 'Images',

  // ── backup.failed ──────────────────────────────────────────────────────
  'backup.failed.label': 'Sauvegarde en échec',
  'backup.failed.description':
    'Une sauvegarde — d’une application ou de la base du panel — n’a pas abouti.',
  'backup.failed.rationale':
    'Une sauvegarde qui échoue en silence est pire que pas de sauvegarde : on croit être ' +
    'couvert. On l’apprend la nuit de l’échec, pas le jour où il faudrait restaurer.',
  'backup.failed.title': 'Sauvegarde en échec — {subject}',
  'backup.failed.panel': 'base du panel',
  'backup.failed.body': 'La sauvegarde de « {subject} »{where} n’a pas abouti : {error}',
  'backup.failed.where': ' sur « {machine} »',
  'backup.failed.bodyDeploy':
    ' Elle précédait un déploiement : celui-ci n’a pas été lancé, rien n’a changé.',
  'backup.failed.summary': '{subject}',

  // ── route.down / route.recovered ───────────────────────────────────────
  'route.down.label': 'Domaine injoignable',
  'route.down.description':
    'Un domaine ne répond plus à travers le reverse proxy de sa machine : route absente, proxy éteint ou application muette.',
  'route.down.rationale':
    'Le site tourne peut-être encore, mais plus personne ne l’atteint par son nom. La sonde passe par le proxy, depuis sa machine : elle voit ce que le DNS public cacherait.',
  'route.down.title': 'Domaine injoignable — {hostname}',
  'route.down.body': '« {hostname} » ({application}, sur « {machine} ») ne répond plus : {error}',
  'route.down.summary': '{hostname}',
  'route.recovered.label': 'Domaine rétabli',
  'route.recovered.description': 'Un domaine qui ne répondait plus répond de nouveau.',
  'route.recovered.rationale':
    'Ferme l’alerte reçue plus tôt : rien à faire, juste à savoir que c’est revenu.',
  'route.recovered.title': 'Domaine rétabli — {hostname}',
  'route.recovered.body': '« {hostname} » ({application}, sur « {machine} ») répond de nouveau.',
  'route.recovered.summary': '{hostname}',
  'field.domain': 'Domaine',
  'field.trigger': 'Déclenchement',
  'backup.trigger.schedule': 'planifiée',
  'backup.trigger.manual': 'à la demande',
  'backup.trigger.pre_deploy': 'avant déploiement',
  'backup.trigger.pre_restore': 'avant restauration',
} as const;

const en: Translated<typeof fr> = {
  'actor.label': 'Triggered by',
  'actor.system': 'the system (scheduled job or worker)',
  'yes': 'yes',
  'no': 'no',
  'roles.none': 'no role',

  'duration.seconds': '{value} s',
  'duration.minutes': '{value} min',
  'duration.hours': '{value} h',
  'duration.hoursMinutes': '{value} h {rest}',
  'duration.days': '{value} d',

  'field.deployment': 'Deployment',
  'field.step': 'Step',
  'field.error': 'Error',
  'field.verdict': 'Verdict',
  'field.attemptedVersion': 'Attempted version',
  'field.restoredVersion': 'Restored version',
  'field.reason': 'Reason',
  'field.url': 'URL',
  'field.account': 'Account',
  'field.name': 'Name',
  'field.selfReset': 'Reset by the account itself',
  'field.closedSessions': 'Sessions closed',
  'field.before': 'Before',
  'field.after': 'After',
  'field.probe': 'Probe',
  'field.target': 'Target',
  'field.observation': 'Observation',
  'field.consecutiveFailures': 'Consecutive failures',
  'field.incident': 'Incident',
  'field.was': 'Was',
  'field.outageDuration': 'Outage duration',
  'field.machine': 'Machine',
  'field.metric': 'Metric',
  'field.threshold': 'Threshold',
  'field.consecutiveReadouts': 'Consecutive readouts',
  'field.thresholdOrigin': 'Threshold origin',
  'field.peakValue': 'Worst value reached',
  'field.breachDuration': 'Breach duration',
  'field.clearedBy': 'Cleared by',

  'monitor.verdict.unreachable': 'unreachable',
  'monitor.verdict.unhealthy': 'answering badly',
  'monitor.verdict.healthy': 'healthy',
  'monitor.verdict.unknown': 'unknown state',
  'monitor.sentence.unreachable': 'is unreachable',
  'monitor.sentence.unhealthy': 'is answering badly',
  'monitor.sentence.healthy': 'answers normally',
  'monitor.sentence.unknown': 'is in an unknown state',
  'monitor.summary': 'site {name}',
  'monitor.summaryWithTarget': 'site {name} — {target}',

  'deployment.failed.label': 'Deployment failed',
  'deployment.failed.description': 'A rollout stopped on a step that errored.',
  'deployment.failed.rationale':
    'The application is not up to date, and nobody knows it until someone opens the ' +
    'deployments screen.',
  'deployment.failed.title': 'Deployment failed',
  'deployment.failed.body':
    'Deployment {id} stopped{step}. The previous version, if it was running, still is.',
  'deployment.failed.bodyStep': ' on step “{step}”',
  'deployment.failed.summaryStep': 'step “{step}”',
  'deployment.summary': 'deployment {id}',

  'deployment.scan_blocked.label': 'Rollout blocked by a scan',
  'deployment.scan_blocked.description':
    'The security scan found a vulnerability past the threshold and stopped the rollout.',
  'deployment.scan_blocked.rationale':
    'This is the one case where the panel deliberately refuses what it was asked to do. ' +
    'Without a message, the operator reads it as an outage and keeps retrying.',
  'deployment.scan_blocked.title': 'Rollout blocked by the security scan',
  'deployment.scan_blocked.body':
    'Deployment {id} was stopped at the scan step: a vulnerability reaches the blocking ' +
    'threshold set for this instance. Nothing went live.',

  'deployment.rolled_back.label': 'Automatic rollback',
  'deployment.rolled_back.description':
    'The healthcheck failed and the panel went back to the previous version on its own.',
  'deployment.rolled_back.rationale':
    'Production changed without anyone asking for it. Exactly the kind of thing you do not ' +
    'want to find out about three days later.',
  'deployment.rolled_back.title': 'Automatic rollback',
  'deployment.rolled_back.body':
    'Version {tried} did not answer the healthcheck. The panel went back on its own to ' +
    'version {restored}, which answers. The rollout has to be done again.',

  'security.two_factor_reset.label': 'Second factor reset',
  'security.two_factor_reset.description': 'An administrator lifted the second factor on an account.',
  'security.two_factor_reset.rationale':
    'This is the move that reopens a protected account. It is legitimate most of the time — ' +
    'which is exactly why someone other than the person doing it has to see it.',
  'security.two_factor_reset.title': 'Second factor reset',
  'security.two_factor_reset.body':
    'The second factor on account {account} was lifted. Its open sessions were closed and ' +
    'its trusted devices forgotten.',
  'security.two_factor_reset.bySelf': 'by the account itself',
  'security.two_factor_reset.bySystem': 'by the system',

  'security.role_changed.label': 'User role changed',
  'security.role_changed.description': 'An account changed role, so it changed permissions.',
  'security.role_changed.rationale':
    'A privilege escalation is the way in to everything else. It has to be visible right ' +
    'away, not at the next quarterly review.',
  'security.role_changed.title': 'User role changed',
  'security.role_changed.body': 'Account {account} moves from “{before}” to “{after}”.',
  'security.summary': 'account {account}',

  'security.signup_pending.label': 'Sign-up awaiting a role',
  'security.signup_pending.description':
    'An account was created through public sign-up; it can reach nothing until someone picks its role.',
  'security.signup_pending.rationale':
    'Without this message, the person waits in front of an empty panel, and nobody knows they are there.',
  'security.signup_pending.title': 'New sign-up: {account}',
  'security.signup_pending.body':
    'Account {account} was just created through public sign-up. It can reach nothing until ' +
    'an administrator assigns it a role.',
  'security.signup_pending.summary': 'awaiting a role',

  'security.api_token_created.label': 'API token created',
  'security.api_token_created.description':
    'Someone created an API token: access that acts on their behalf, without a browser or second factor.',
  'security.api_token_created.rationale':
    'A token leaks more easily than a session — into a repository, a CI log. ' +
    'Seeing it appear means knowing it exists on the day it has to be cut off.',
  'security.api_token_created.title': 'API token “{name}” created',
  'security.api_token_created.body':
    'Account {account} created token “{name}”: {permissions} permission(s), {applications}.',
  'security.api_token_created.allApplications': 'all applications',
  'security.api_token_created.someApplications': '{count} application(s)',
  'security.api_token_created.noExpiry': 'no expiry',
  'field.token': 'Token',
  'field.expires': 'Expiry',

  'security.host_key_changed.label': 'Target host key changed',
  'security.host_key_changed.description':
    'A target presented another SSH key than the recorded one: Pupitre refuses to connect.',
  'security.host_key_changed.rationale':
    'Either the machine was reinstalled, or another one is impersonating it. ' +
    'Either way, nothing is deployed there until someone decides.',
  'security.host_key_changed.title': 'Host key changed on “{machine}”',
  'security.host_key_changed.body':
    'Target {machine} ({host}) presented another SSH key than the recorded one. ' +
    'Pupitre refuses to connect. If it was reinstalled, accept the new key on its page; ' +
    'otherwise, find out who is impersonating it.',
  'security.host_key_changed.summary': 'target {machine}',
  'field.expectedKey': 'Recorded key',
  'field.presentedKey': 'Presented key',

  'monitor.down.label': 'Site down',
  'monitor.down.description':
    'A probe confirmed a site no longer answers as expected, past its consecutive-failure threshold.',
  'monitor.down.rationale':
    'The only event in the catalog about what is **already live**, rather than what you are ' +
    'trying to put there. A site that falls over leaves no other trace: nobody refreshes the ' +
    'probes screen at three in the morning.',
  'monitor.down.title': 'Site down — {name}',
  'monitor.down.body':
    'Probe “{name}” on {target} {verdict}{detail}. ' +
    'The outage is confirmed{failures} — this is not an isolated bounce.',
  'monitor.down.bodyDetail': ': {detail}',
  'monitor.down.bodyFailures': ' after {count} consecutive failures',
  'monitor.down.summaryDetail': '{verdict} — {detail}',

  'monitor.recovered.label': 'Site recovered',
  'monitor.recovered.description':
    'A probe that was down went back to green, past its consecutive-success threshold.',
  'monitor.recovered.rationale':
    'The only “success” in the catalog, and that is deliberate: it speaks only to someone who ' +
    'already got the outage. An alert without its counterpart forces a manual check — exactly ' +
    'what probes were installed to avoid.',
  'monitor.recovered.title': 'Site recovered — {name}',
  'monitor.recovered.body':
    'Probe “{name}” on {target} answers normally again. ' +
    'The incident is closed{duration}. ' +
    'Nothing is expected of you.',
  'monitor.recovered.bodyDuration': ' after {duration} down',
  'monitor.recovered.summaryDetail': 'recovered after {duration} down',
  'monitor.recovered.summaryPlain': 'recovered',

  'target.threshold.breached.label': 'Machine threshold breached',
  'target.threshold.breached.description':
    'A target machine went past a load, memory or disk threshold, confirmed over several ' +
    'consecutive readouts.',
  'target.threshold.breached.rationale':
    'A disk filling up breaks nothing until it breaks everything, and it does not break only ' +
    'the application you are watching: it breaks every one the machine carries. This is the ' +
    'only event in the catalog that warns **before** the outage rather than after.',
  'target.threshold.breached.title': 'Threshold breached — {machine}',
  'target.threshold.breached.observation': 'threshold exceeded',
  'target.threshold.breached.summary': 'machine {machine} — {observation}',
  'target.threshold.breached.summaryDetail': '{observation} (threshold {limit}%)',
  'target.threshold.breached.body':
    'Machine “{machine}” breached a monitoring threshold: {observation}. ',
  'target.threshold.breached.bodyLimit': 'The threshold is set at {limit}%. ',
  'target.threshold.breached.bodyReadouts':
    'The breach is confirmed over {count} consecutive readout(s) — this is not an isolated spike. ',
  'target.threshold.breached.bodyExposure':
    'Every application deployed on this machine is exposed, not just the one being watched.',
  'target.threshold.percent': '{limit}%',

  'target.threshold.cleared.label': 'Machine threshold cleared',
  'target.threshold.cleared.description':
    'A target machine went back under a threshold it had breached.',
  'target.threshold.cleared.rationale':
    'The counterpart of the previous one, and for the same reason as a recovered site: ' +
    'without it, nobody knows whether the alert from last night still holds this morning.',
  'target.threshold.cleared.title': 'Threshold cleared — {machine}',
  'target.threshold.cleared.metric': 'threshold',
  'target.threshold.cleared.observation': 'below the threshold',
  'target.threshold.cleared.summary': 'machine {machine} — {metric} below the threshold',
  'target.threshold.cleared.summaryDisabled':
    'the threshold was turned off, the machine has not necessarily changed',
  'target.threshold.cleared.bodyDisabled':
    'The alert on “{machine}” ({metric}) is cleared because the threshold was turned off, ' +
    '**not** because the machine came back under it. Nothing says the situation improved.',
  'target.threshold.cleared.body': 'Machine “{machine}” is back under its {metric} threshold. ',
  'target.threshold.cleared.bodyDuration': 'The breach lasted {duration}.',
  'target.threshold.cleared.byDisabled': 'threshold turned off',
  'target.threshold.cleared.byCrossed': 'back under the threshold',

  'image.update.available.label': 'Image update available',
  'image.update.available.description':
    'An image of a deployed application was republished under the same tag, or a newer ' +
    'version of the same series came out.',
  'image.update.available.rationale':
    'A base image gets its security fixes by republishing the same tag: without a redeploy, ' +
    'the application keeps the flaws fixed since. The panel checks every six hours and ' +
    'announces each novelty once.',
  'image.update.available.title': 'Image update — {app}',
  'image.update.available.summary': '{app} on {machine}',
  'image.update.available.summaryDetail': '{count} image(s)',
  'image.update.available.body': 'Something new for “{app}” on “{machine}”. ',
  'image.update.available.bodyOutdated':
    'Republished since the deployment: {images}. Redeploying the running version fetches the ' +
    'new content, nothing else changes. ',
  'image.update.available.bodyNewer':
    'Newer version published: {images}. Changing the tag is done in the AppSpec.',
  'field.application': 'Application',
  'field.images': 'Images',

  'backup.failed.label': 'Backup failed',
  'backup.failed.description': 'A backup — of an application or of the panel database — failed.',
  'backup.failed.rationale':
    'A backup that fails silently is worse than no backup: you believe you are covered. ' +
    'You learn it the night it fails, not the day you would need to restore.',
  'backup.failed.title': 'Backup failed — {subject}',
  'backup.failed.panel': 'panel database',
  'backup.failed.body': 'The backup of “{subject}”{where} failed: {error}',
  'backup.failed.where': ' on “{machine}”',
  'backup.failed.bodyDeploy':
    ' It preceded a deployment: that deployment was not started, nothing changed.',
  'backup.failed.summary': '{subject}',

  'route.down.label': 'Domain unreachable',
  'route.down.description':
    'A domain no longer answers through the reverse proxy of its machine: route missing, proxy down or application silent.',
  'route.down.rationale':
    'The site may still run, but nobody reaches it by its name any more. The probe goes through the proxy, from its machine: it sees what public DNS would hide.',
  'route.down.title': 'Domain unreachable — {hostname}',
  'route.down.body': '“{hostname}” ({application}, on “{machine}”) no longer answers: {error}',
  'route.down.summary': '{hostname}',
  'route.recovered.label': 'Domain back',
  'route.recovered.description': 'A domain that stopped answering answers again.',
  'route.recovered.rationale': 'Closes the earlier alert: nothing to do, just to know it is back.',
  'route.recovered.title': 'Domain back — {hostname}',
  'route.recovered.body': '“{hostname}” ({application}, on “{machine}”) answers again.',
  'route.recovered.summary': '{hostname}',
  'field.domain': 'Domain',
  'field.trigger': 'Trigger',
  'backup.trigger.schedule': 'scheduled',
  'backup.trigger.manual': 'on demand',
  'backup.trigger.pre_deploy': 'before deployment',
  'backup.trigger.pre_restore': 'before restore',
};

const EVENT_TEXT = { fr, en };

/**
 * Chaque événement du catalogue porte ses trois textes de présentation. Le
 * compilateur le vérifie ici plutôt qu'à l'exécution : un événement ajouté sans
 * libellé ne compile pas.
 */
const _eventTextParity: Record<
  `${NotificationEventKey}.${'label' | 'description' | 'rationale'}`,
  string
> = fr;
void _eventTextParity;

function t(language: UiLanguage, key: keyof typeof fr, vars?: Vars): string {
  return renderMessage(EVENT_TEXT, language, key, vars);
}

/** L'entrée d'audit, réduite à ce dont la correspondance a besoin. */
export type NotifiableAuditEntry = {
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorId: string | null;
  before: unknown;
  after: unknown;
};

/** Ce que l'émetteur sait de son propre contexte au moment de composer. */
export type NotificationRenderContext = {
  /** Nom de l'instance, tel que les paramètres le portent. */
  instance: string;
  /** Racine du panel, sans barre finale. `null` si elle n'est pas connue. */
  panelUrl: string | null;
  /** E-mail de l'acteur, quand il a pu être résolu. `null` pour le système. */
  actor: string | null;
  occurredAt: string;
  /**
   * Langue de l'instance, tirée de `settings.locale` par `languageOf()`.
   *
   * Elle descend en paramètre parce que `packages/core` ne dépend pas de
   * `@pupitre/db` et ne peut donc pas lire les paramètres : c'est l'appelant —
   * le worker, ou le panel pour l'essai de canal — qui la résout. Même motif
   * que `panelUrl` et `instance`.
   */
  language: UiLanguage;
};

type RenderedEvent = {
  title: string;
  body: string;
  fields: NotificationField[];
  /** Chemin relatif dans le panel, ex. `/deployments/xxx`. `null` s'il n'y en a pas. */
  path: string | null;
  /**
   * Ce qu'une **ligne de résumé** nomme, quand cet événement est regroupé avec
   * d'autres du même type. Obligatoire, et c'est voulu : c'est cette ligne qui
   * empêche un résumé d'être un compteur muet. Elle nomme l'objet concerné —
   * « déploiement 4f2a… », « compte alice@… » — jamais la catégorie, qui est
   * déjà dans le titre du résumé.
   */
  summary: string;
  /** Précision courte de la ligne de résumé : l'étape, le verdict, la transition. */
  summaryDetail: string | null;
};

/**
 * Le descripteur ne porte plus ses textes : ils vivent dans le dictionnaire
 * ci-dessus, sous les clés `<événement>.label`, `.description` et `.rationale`.
 * Un descripteur est de la structure — une gravité, une action d'audit, un
 * chemin —, et la structure n'a pas de langue. Les textes se lisent par
 * `notificationEventLabel()` et `presentNotificationEvents()`, qui prennent
 * tous deux la langue.
 */
export type NotificationEventDescriptor = {
  readonly key: NotificationEventKey;
  readonly severity: NotificationSeverity;
  /** Action d'audit qui porte l'événement. */
  readonly auditAction: string;
  /**
   * Écran du panel qui montre *l'ensemble* de ces objets. Un résumé porte
   * plusieurs objets : il ne peut pas pointer la fiche de l'un d'eux.
   */
  readonly digestPath: string | null;
  /**
   * Départage deux événements portés par la même action d'audit. Un scan qui
   * bloque et un déploiement qui casse s'écrivent tous deux `deployment.failed` :
   * seul `failedStep` les distingue.
   */
  readonly matches: (entry: NotifiableAuditEntry) => boolean;
  readonly render: (entry: NotifiableAuditEntry, ctx: NotificationRenderContext) => RenderedEvent;
  /**
   * Ce qui distingue **deux occurrences successives** du même événement sur le
   * même objet, quand l'identifiant de la ressource n'y suffit pas.
   *
   * L'anti-doublon de la distribution porte sur le couple (événement,
   * ressource) pendant cinq minutes. Pour un déploiement, cela va de soi :
   * chaque déploiement a son identifiant, et la fenêtre ne sert qu'à absorber
   * les trois tentatives que BullMQ écrit pour un même incident.
   *
   * Pour une sonde, non. L'identifiant est celui de la **sonde**, stable d'une
   * panne à l'autre : deux pannes distinctes du même site à moins de cinq
   * minutes d'intervalle se confondaient, et la seconde alerte était avalée
   * sans trace. Un descripteur peut donc fournir ici un discriminant tiré de sa
   * charge utile — l'identifiant d'incident, typiquement — qui sépare les
   * occurrences sans rien changer à l'absorption des rejeux, puisqu'un rejeu
   * recopie la même charge.
   *
   * `undefined` garde le comportement d'origine.
   */
  readonly dedupDiscriminator?: (entry: NotifiableAuditEntry) => string | null;
};

// ─── lecture défensive des charges utiles d'audit ─────────────────────────────

/**
 * `before` et `after` sont des JSONB : leur forme n'est garantie par rien.
 * Une notification ne doit jamais échouer parce qu'un champ a bougé — au pire
 * elle est moins précise.
 */
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim().slice(0, 480);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.length > 0) return value.map(String).join(', ').slice(0, 480);
  return fallback;
}

function optional(value: unknown): string | null {
  const rendered = text(value, '');
  return rendered.length > 0 ? rendered : null;
}

/** N'ajoute un champ que s'il a une valeur — une ligne « — » n'apprend rien. */
function fieldsOf(entries: [string, string | null][]): NotificationField[] {
  return entries
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([label, value]) => ({ label, value }));
}

function actorField(ctx: NotificationRenderContext): [string, string | null] {
  return [t(ctx.language, 'actor.label'), ctx.actor ?? t(ctx.language, 'actor.system')];
}

/**
 * Borne une chaîne, en le disant.
 *
 * `notificationDigestItemSchema` plafonne `label` à 200 caractères et `detail`
 * à 300 : au-delà, le `parse()` **lève**, la tâche de distribution échoue et
 * l'alerte est perdue. Ce n'est pas théorique — une URL de sonde est acceptée
 * jusqu'à 2 048 caractères. Une ligne de résumé tronquée est une gêne ; une
 * alerte de panne jamais partie est une panne.
 */
function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// ─── vocabulaire de la supervision ────────────────────────────────────────────

/**
 * Le verdict d'une sonde. Il vit ici et non dans un `switch` chez l'appelant :
 * c'est de la mise en forme de message, et `message.ts` interdit qu'elle fuie
 * ailleurs.
 *
 * Le `switch` porte sur le **statut**, qui est une donnée, et rend une clé de
 * dictionnaire. C'est ce qui garde une seule table de correspondance quelle que
 * soit la langue.
 */
function monitorVerdict(language: UiLanguage, status: unknown): string {
  switch (text(status, '')) {
    case 'unreachable':
      return t(language, 'monitor.verdict.unreachable');
    case 'unhealthy':
      return t(language, 'monitor.verdict.unhealthy');
    case 'healthy':
      return t(language, 'monitor.verdict.healthy');
    default:
      return t(language, 'monitor.verdict.unknown');
  }
}

/**
 * Le même verdict, mais en prédicat.
 *
 * Deux fonctions et non une, parce que le français ne se laisse pas
 * concaténer : « est injoignable » se dit avec le verbe être, « répond mal »
 * porte le sien. Coller un `est ${verdict}` devant l'adjectif donnait « est
 * répond mal ». Constaté à la première exécution, pas supposé. L'anglais a
 * exactement le même problème (*is unreachable* contre *answers normally*),
 * donc la même paire de clés.
 */
function monitorVerdictSentence(language: UiLanguage, status: unknown): string {
  switch (text(status, '')) {
    case 'unreachable':
      return t(language, 'monitor.sentence.unreachable');
    case 'unhealthy':
      return t(language, 'monitor.sentence.unhealthy');
    case 'healthy':
      return t(language, 'monitor.sentence.healthy');
    default:
      return t(language, 'monitor.sentence.unknown');
  }
}

/** « 4 min », « 1 h 20 », « 2 j ». `null` quand la durée n'est pas connue. */
function monitorDuration(language: UiLanguage, seconds: unknown): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  if (total < 60) return t(language, 'duration.seconds', { value: total });
  const minutes = Math.round(total / 60);
  if (minutes < 60) return t(language, 'duration.minutes', { value: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) {
    return rest === 0
      ? t(language, 'duration.hours', { value: hours })
      : t(language, 'duration.hoursMinutes', { value: hours, rest });
  }
  return t(language, 'duration.days', { value: Math.floor(hours / 24) });
}

/**
 * Ce qui identifie la sonde dans une ligne de résumé.
 *
 * Le nom **et** la cible, parce que ce ne sont pas les mêmes informations :
 * l'opérateur a nommé la sonde (« boutique »), mais c'est l'URL qui dit
 * laquelle des trois boutiques est tombée. Un résumé de douze pannes doit
 * pouvoir se lire sans ouvrir le panel.
 */
function monitorLabel(language: UiLanguage, entry: NotifiableAuditEntry): string {
  const after = record(entry.after);
  const name = text(after.name, entry.resourceId ?? '?');
  const target = optional(after.target);
  return clip(
    target === null || target === name
      ? t(language, 'monitor.summary', { name })
      : t(language, 'monitor.summaryWithTarget', { name, target }),
    200,
  );
}

const CATALOG = {
  'deployment.failed': {
    key: 'deployment.failed',
    severity: 'critical',
    auditAction: 'deployment.failed',
    digestPath: '/deployments',
    matches: (entry) => text(record(entry.after).failedStep, '') !== 'scan',
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const step = optional(after.failedStep);
      return {
        title: t(lang, 'deployment.failed.title'),
        body: t(lang, 'deployment.failed.body', {
          id: entry.resourceId ?? '',
          step: step ? t(lang, 'deployment.failed.bodyStep', { step }) : '',
        }),
        fields: fieldsOf([
          [t(lang, 'field.deployment'), entry.resourceId],
          [t(lang, 'field.step'), step],
          [t(lang, 'field.error'), optional(after.error)],
          actorField(ctx),
        ]),
        path: entry.resourceId ? `/deployments/${entry.resourceId}` : null,
        summary: t(lang, 'deployment.summary', { id: entry.resourceId ?? '?' }),
        summaryDetail: step
          ? t(lang, 'deployment.failed.summaryStep', { step })
          : optional(after.error),
      };
    },
  },
  'deployment.scan_blocked': {
    key: 'deployment.scan_blocked',
    severity: 'critical',
    auditAction: 'deployment.failed',
    digestPath: '/deployments',
    matches: (entry) => text(record(entry.after).failedStep, '') === 'scan',
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      return {
        title: t(lang, 'deployment.scan_blocked.title'),
        body: t(lang, 'deployment.scan_blocked.body', { id: entry.resourceId ?? '' }),
        fields: fieldsOf([
          [t(lang, 'field.deployment'), entry.resourceId],
          [t(lang, 'field.verdict'), optional(after.error)],
          actorField(ctx),
        ]),
        path: entry.resourceId ? `/deployments/${entry.resourceId}` : null,
        summary: t(lang, 'deployment.summary', { id: entry.resourceId ?? '?' }),
        summaryDetail: optional(after.error),
      };
    },
  },
  'deployment.rolled_back': {
    key: 'deployment.rolled_back',
    severity: 'warning',
    auditAction: 'deployment.rolled_back.automatic',
    digestPath: '/deployments',
    matches: () => true,
    render: (entry, ctx) => {
      const after = record(entry.after);
      const before = record(entry.before);
      const lang = ctx.language;
      return {
        title: t(lang, 'deployment.rolled_back.title'),
        body: t(lang, 'deployment.rolled_back.body', {
          tried: text(before.version, '?'),
          restored: text(after.restoredVersion, '?'),
        }),
        fields: fieldsOf([
          [t(lang, 'field.deployment'), entry.resourceId],
          [t(lang, 'field.attemptedVersion'), optional(before.version)],
          [t(lang, 'field.restoredVersion'), optional(after.restoredVersion)],
          [t(lang, 'field.reason'), optional(after.reason)],
          [t(lang, 'field.url'), optional(after.url)],
          actorField(ctx),
        ]),
        path: entry.resourceId ? `/deployments/${entry.resourceId}` : null,
        summary: t(lang, 'deployment.summary', { id: entry.resourceId ?? '?' }),
        // Deux versions et une flèche : pas une phrase, rien à traduire.
        summaryDetail: `${text(before.version, '?')} → ${text(after.restoredVersion, '?')}`,
      };
    },
  },
  'security.two_factor_reset': {
    key: 'security.two_factor_reset',
    severity: 'warning',
    auditAction: 'user.2fa.reset',
    digestPath: '/admin/users',
    matches: () => true,
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const account = text(after.email, entry.resourceId ?? '?');
      return {
        title: t(lang, 'security.two_factor_reset.title'),
        body: t(lang, 'security.two_factor_reset.body', { account }),
        fields: fieldsOf([
          [t(lang, 'field.account'), account],
          [t(lang, 'field.selfReset'), after.self === true ? t(lang, 'yes') : t(lang, 'no')],
          [t(lang, 'field.closedSessions'), optional(after.revokedSessions)],
          actorField(ctx),
        ]),
        path: '/admin/users',
        summary: t(lang, 'security.summary', { account }),
        summaryDetail:
          after.self === true
            ? t(lang, 'security.two_factor_reset.bySelf')
            : (ctx.actor ?? t(lang, 'security.two_factor_reset.bySystem')),
      };
    },
  },
  'security.role_changed': {
    key: 'security.role_changed',
    severity: 'warning',
    auditAction: 'user.role.changed',
    digestPath: '/admin/users',
    matches: () => true,
    render: (entry, ctx) => {
      const after = record(entry.after);
      const before = record(entry.before);
      const lang = ctx.language;
      const account = text(after.email, entry.resourceId ?? '?');
      const none = t(lang, 'roles.none');
      return {
        title: t(lang, 'security.role_changed.title'),
        body: t(lang, 'security.role_changed.body', {
          account,
          before: text(before.roles, none),
          after: text(after.roles, '?'),
        }),
        fields: fieldsOf([
          [t(lang, 'field.account'), account],
          [t(lang, 'field.before'), optional(before.roles) ?? none],
          [t(lang, 'field.after'), optional(after.roles)],
          actorField(ctx),
        ]),
        path: '/admin/users',
        summary: t(lang, 'security.summary', { account }),
        summaryDetail: `${optional(before.roles) ?? none} → ${text(after.roles, '?')}`,
      };
    },
  },
  'security.signup_pending': {
    key: 'security.signup_pending',
    severity: 'info',
    auditAction: 'user.created',
    digestPath: '/admin/users',
    // Le hook de création écrit le rôle attribué. Seule l'inscription publique
    // donne le rôle sans accès : un compte créé par un administrateur porte
    // déjà le rôle qu'il a choisi, il n'attend personne.
    matches: (entry) => record(entry.after).role === SIGNUP_ROLE,
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const account = text(after.email, entry.resourceId ?? '?');
      return {
        title: t(lang, 'security.signup_pending.title', { account }),
        body: t(lang, 'security.signup_pending.body', { account }),
        fields: fieldsOf([
          [t(lang, 'field.account'), account],
          [t(lang, 'field.name'), optional(after.name)],
        ]),
        path: '/admin/users',
        summary: t(lang, 'security.summary', { account }),
        summaryDetail: t(lang, 'security.signup_pending.summary'),
      };
    },
  },
  'security.api_token_created': {
    key: 'security.api_token_created',
    severity: 'info',
    auditAction: 'api_token.created',
    digestPath: '/admin/users',
    matches: () => true,
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const account = text(after.ownerEmail, ctx.actor ?? '?');
      const name = text(after.name, '?');
      const permissions = Array.isArray(after.permissions) ? after.permissions.length : 0;
      const applications = Array.isArray(after.applicationIds)
        ? t(lang, 'security.api_token_created.someApplications', {
            count: after.applicationIds.length,
          })
        : t(lang, 'security.api_token_created.allApplications');
      return {
        title: t(lang, 'security.api_token_created.title', { name }),
        body: t(lang, 'security.api_token_created.body', {
          account,
          name,
          permissions,
          applications,
        }),
        fields: fieldsOf([
          [t(lang, 'field.account'), account],
          [t(lang, 'field.token'), optional(after.prefix)],
          [
            t(lang, 'field.expires'),
            optional(after.expiresAt) ?? t(lang, 'security.api_token_created.noExpiry'),
          ],
        ]),
        path: '/admin/users',
        summary: t(lang, 'security.summary', { account }),
        summaryDetail: name,
      };
    },
  },
  'security.host_key_changed': {
    key: 'security.host_key_changed',
    severity: 'critical',
    auditAction: 'target.host_key.mismatch',
    digestPath: '/targets',
    matches: () => true,
    // Une clé inattendue par message : le worker ne l'écrit qu'une fois par clé.
    dedupDiscriminator: (entry) => optional(record(entry.after).presented),
    render: (entry, ctx) => {
      const after = record(entry.after);
      const before = record(entry.before);
      const lang = ctx.language;
      const machine = text(after.name, entry.resourceId ?? '?');
      const host = text(after.host, '?');
      return {
        title: t(lang, 'security.host_key_changed.title', { machine }),
        body: t(lang, 'security.host_key_changed.body', { machine, host }),
        fields: fieldsOf([
          [t(lang, 'field.target'), machine],
          [t(lang, 'field.expectedKey'), optional(before.fingerprint)],
          [t(lang, 'field.presentedKey'), optional(after.presented)],
        ]),
        path: entry.resourceId ? `/targets/${entry.resourceId}` : '/targets',
        summary: t(lang, 'security.host_key_changed.summary', { machine }),
        summaryDetail: text(after.presented, '?'),
      };
    },
  },
  'monitor.down': {
    key: 'monitor.down',
    severity: 'critical',
    auditAction: 'monitor.down',
    digestPath: '/monitors',
    // Une seule action d'audit porte cet événement, et la machine à états a
    // déjà écarté les rebonds : rien à départager ici.
    // L'anti-doublon porte sur (événement, ressource), et la ressource d'une
    // sonde est la sonde — la même d'une panne à l'autre. Deux pannes
    // distinctes du même site à moins de cinq minutes se confondaient donc, et
    // la seconde alerte disparaissait sans trace. L'identifiant d'incident les
    // sépare ; un rejeu de la même tâche, lui, le recopie et reste absorbé.
    dedupDiscriminator: (entry) => optional(record(entry.after).incidentId),
    matches: () => true,
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const verdict = monitorVerdict(lang, after.status);
      const failures = optional(after.consecutiveFailures);
      const target = text(after.target, '?');
      const detail = optional(after.detail);

      return {
        title: t(lang, 'monitor.down.title', { name: text(after.name, entry.resourceId ?? '?') }),
        body: t(lang, 'monitor.down.body', {
          name: text(after.name, '?'),
          target,
          verdict: monitorVerdictSentence(lang, after.status),
          detail: detail ? t(lang, 'monitor.down.bodyDetail', { detail }) : '',
          failures: failures ? t(lang, 'monitor.down.bodyFailures', { count: failures }) : '',
        }),
        fields: fieldsOf([
          [t(lang, 'field.probe'), optional(after.name)],
          [t(lang, 'field.target'), optional(after.target)],
          [t(lang, 'field.verdict'), verdict],
          [t(lang, 'field.observation'), detail],
          [t(lang, 'field.consecutiveFailures'), failures],
          [t(lang, 'field.incident'), optional(after.incidentId)],
          actorField(ctx),
        ]),
        path: entry.resourceId ? `/monitors/${entry.resourceId}` : null,
        summary: monitorLabel(lang, entry),
        // La nature de la panne, pas la catégorie : c'est elle qui distingue
        // « le serveur rend 503 » de « plus rien n'écoute sur le port ».
        summaryDetail: clip(
          detail ? t(lang, 'monitor.down.summaryDetail', { verdict, detail }) : verdict,
          300,
        ),
      };
    },
  },
  'monitor.recovered': {
    key: 'monitor.recovered',
    // `info` et non `warning` : un rétablissement ne demande aucun geste. La
    // gravité sert au routage et à la couleur ; la peindre en rouge apprendrait
    // à ignorer le rouge.
    severity: 'info',
    auditAction: 'monitor.recovered',
    digestPath: '/monitors',
    // L'anti-doublon porte sur (événement, ressource), et la ressource d'une
    // sonde est la sonde — la même d'une panne à l'autre. Deux pannes
    // distinctes du même site à moins de cinq minutes se confondaient donc, et
    // la seconde alerte disparaissait sans trace. L'identifiant d'incident les
    // sépare ; un rejeu de la même tâche, lui, le recopie et reste absorbé.
    dedupDiscriminator: (entry) => optional(record(entry.after).incidentId),
    matches: () => true,
    render: (entry, ctx) => {
      const after = record(entry.after);
      const before = record(entry.before);
      const lang = ctx.language;
      const duration = monitorDuration(lang, after.durationSeconds);
      const target = text(after.target, '?');

      return {
        title: t(lang, 'monitor.recovered.title', {
          name: text(after.name, entry.resourceId ?? '?'),
        }),
        body: t(lang, 'monitor.recovered.body', {
          name: text(after.name, '?'),
          target,
          duration: duration ? t(lang, 'monitor.recovered.bodyDuration', { duration }) : '',
        }),
        fields: fieldsOf([
          [t(lang, 'field.probe'), optional(after.name)],
          [t(lang, 'field.target'), optional(after.target)],
          [t(lang, 'field.was'), monitorVerdict(lang, before.status)],
          [t(lang, 'field.outageDuration'), duration],
          [t(lang, 'field.incident'), optional(after.incidentId)],
          actorField(ctx),
        ]),
        path: entry.resourceId ? `/monitors/${entry.resourceId}` : null,
        summary: monitorLabel(lang, entry),
        summaryDetail: duration
          ? t(lang, 'monitor.recovered.summaryDetail', { duration })
          : t(lang, 'monitor.recovered.summaryPlain'),
      };
    },
  },
  'target.threshold.breached': {
    key: 'target.threshold.breached',
    severity: 'warning',
    auditAction: 'target.threshold.breached',
    digestPath: '/apps',
    matches: () => true,
    // Un épisode par franchissement, et son identifiant ne bouge pas tant qu'il
    // dure : deux franchissements successifs de la même métrique sur la même
    // machine sont deux épisodes, donc deux messages. Sans lui, la ressource
    // serait la machine, identique d'un épisode à l'autre.
    dedupDiscriminator: (entry) => optional(record(entry.after).breachId),
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const machine = text(after.targetName, '?');
      const constat = text(after.detail, t(lang, 'target.threshold.breached.observation'));
      const limite = optional(after.limitPercent);
      const releves = optional(after.samples);

      return {
        title: t(lang, 'target.threshold.breached.title', { machine }),
        summary: t(lang, 'target.threshold.breached.summary', { machine, observation: constat }),
        summaryDetail:
          limite === null
            ? constat
            : t(lang, 'target.threshold.breached.summaryDetail', {
                observation: constat,
                limit: limite,
              }),
        body:
          t(lang, 'target.threshold.breached.body', { machine, observation: constat }) +
          (limite === null
            ? ''
            : t(lang, 'target.threshold.breached.bodyLimit', { limit: limite })) +
          (releves === null
            ? ''
            : t(lang, 'target.threshold.breached.bodyReadouts', { count: releves })) +
          t(lang, 'target.threshold.breached.bodyExposure'),
        fields: fieldsOf([
          [t(lang, 'field.machine'), machine],
          [t(lang, 'field.metric'), optional(after.metricLabel)],
          [t(lang, 'field.observation'), constat],
          [
            t(lang, 'field.threshold'),
            limite === null ? null : t(lang, 'target.threshold.percent', { limit: limite }),
          ],
          [t(lang, 'field.consecutiveReadouts'), releves],
          [t(lang, 'field.thresholdOrigin'), optional(after.thresholdOrigin)],
          actorField(ctx),
        ]),
        path: '/apps',
      };
    },
  },
  'target.threshold.cleared': {
    key: 'target.threshold.cleared',
    severity: 'info',
    auditAction: 'target.threshold.cleared',
    digestPath: '/apps',
    matches: () => true,
    dedupDiscriminator: (entry) => optional(record(entry.after).breachId),
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const machine = text(after.targetName, '?');
      const metrique = text(after.metricLabel, t(lang, 'target.threshold.cleared.metric'));
      const duree = optional(after.durationSeconds);
      // `threshold_disabled` : l'épisode s'est refermé parce qu'on a coupé le
      // seuil, pas parce que la machine va mieux. Le taire serait un faux
      // soulagement — c'est exactement le genre de message qu'on lit vite.
      const coupe = text(after.reason, 'crossed') === 'threshold_disabled';

      return {
        title: t(lang, 'target.threshold.cleared.title', { machine }),
        summary: t(lang, 'target.threshold.cleared.summary', {
          machine,
          metric: metrique.toLowerCase(),
        }),
        summaryDetail: coupe
          ? t(lang, 'target.threshold.cleared.summaryDisabled')
          : text(after.detail, t(lang, 'target.threshold.cleared.observation')),
        body: coupe
          ? t(lang, 'target.threshold.cleared.bodyDisabled', {
              machine,
              metric: metrique.toLowerCase(),
            })
          : t(lang, 'target.threshold.cleared.body', {
              machine,
              metric: metrique.toLowerCase(),
            }) +
            (duree === null
              ? ''
              : t(lang, 'target.threshold.cleared.bodyDuration', {
                  // `duree` sort d'`optional()`, donc c'est une chaîne, et
                  // `monitorDuration()` n'accepte qu'un nombre : elle rend
                  // `null` ici depuis toujours. Comportement reproduit tel
                  // quel — le corriger n'est pas le travail d'une traduction.
                  duration: String(monitorDuration(lang, duree)),
                })),
        fields: fieldsOf([
          [t(lang, 'field.machine'), machine],
          [t(lang, 'field.metric'), optional(after.metricLabel)],
          [t(lang, 'field.peakValue'), optional(after.peakValue)],
          [
            t(lang, 'field.breachDuration'),
            duree === null ? null : monitorDuration(lang, duree),
          ],
          [
            t(lang, 'field.clearedBy'),
            coupe
              ? t(lang, 'target.threshold.cleared.byDisabled')
              : t(lang, 'target.threshold.cleared.byCrossed'),
          ],
          actorField(ctx),
        ]),
        path: '/apps',
      };
    },
  },
  'image.update.available': {
    key: 'image.update.available',
    severity: 'warning',
    auditAction: 'image.update.available',
    digestPath: '/applications',
    matches: () => true,
    // La ressource est l'application, stable d'une annonce à l'autre : c'est la
    // nouveauté elle-même (digests, tags) qui distingue deux annonces.
    dedupDiscriminator: (entry) => optional(record(entry.after).noticeKey),
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const app = text(after.applicationName ?? after.application, '?');
      const machine = text(after.targetName, '?');
      const images = Array.isArray(after.images) ? after.images.map(record) : [];
      const outdated = images
        .filter((image) => image.status === 'outdated')
        .map((image) => `${text(image.image, '?')} (${text(image.service, '?')})`);
      const newer = images
        .filter((image) => optional(image.newerTag) !== null)
        .map(
          (image) =>
            `${text(image.image, '?')} → ${text(image.newerTag, '?')} (${text(image.service, '?')})`,
        );

      return {
        title: t(lang, 'image.update.available.title', { app }),
        summary: clip(t(lang, 'image.update.available.summary', { app, machine }), 200),
        summaryDetail: t(lang, 'image.update.available.summaryDetail', { count: images.length }),
        body:
          t(lang, 'image.update.available.body', { app, machine }) +
          (outdated.length > 0
            ? t(lang, 'image.update.available.bodyOutdated', { images: outdated.join(', ') })
            : '') +
          (newer.length > 0
            ? t(lang, 'image.update.available.bodyNewer', { images: newer.join(', ') })
            : ''),
        fields: fieldsOf([
          [t(lang, 'field.application'), app],
          [t(lang, 'field.machine'), machine],
          [t(lang, 'field.images'), [...outdated, ...newer].join(' · ') || null],
          actorField(ctx),
        ]),
        path: entry.resourceId ? `/applications/${entry.resourceId}` : '/applications',
      };
    },
  },
  'backup.failed': {
    key: 'backup.failed',
    severity: 'critical',
    auditAction: 'backup.failed',
    digestPath: '/applications',
    matches: () => true,
    // La ressource est l'application (ou le panel), stable d'une nuit à
    // l'autre : c'est la sauvegarde elle-même qui distingue deux échecs.
    dedupDiscriminator: (entry) => optional(record(entry.after).backupId),
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const subject =
        after.kind === 'panel'
          ? t(lang, 'backup.failed.panel')
          : text(after.applicationName ?? after.application, '?');
      const machine = optional(after.targetName);
      const trigger = text(after.trigger, 'schedule');
      const known = ['schedule', 'manual', 'pre_deploy', 'pre_restore'].includes(trigger);
      const error = text(after.error, '?');
      return {
        title: t(lang, 'backup.failed.title', { subject }),
        summary: clip(t(lang, 'backup.failed.summary', { subject }), 200),
        summaryDetail: clip(error, 300),
        body:
          t(lang, 'backup.failed.body', {
            subject,
            where: machine ? t(lang, 'backup.failed.where', { machine }) : '',
            error,
          }) + (trigger === 'pre_deploy' ? t(lang, 'backup.failed.bodyDeploy') : ''),
        fields: fieldsOf([
          [t(lang, 'field.application'), after.kind === 'panel' ? null : subject],
          [t(lang, 'field.machine'), machine],
          [
            t(lang, 'field.trigger'),
            known ? t(lang, `backup.trigger.${trigger as 'schedule'}`) : trigger,
          ],
          [t(lang, 'field.error'), error],
          actorField(ctx),
        ]),
        path:
          after.kind === 'panel'
            ? '/admin/settings'
            : entry.resourceId
              ? `/applications/${entry.resourceId}`
              : '/applications',
      };
    },
  },
  'route.down': {
    key: 'route.down',
    severity: 'warning',
    auditAction: 'route.down',
    digestPath: '/applications',
    matches: () => true,
    dedupDiscriminator: (entry) => optional(record(entry.after).hostname),
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const hostname = text(after.hostname, '?');
      const application = text(after.application, '?');
      const machine = text(after.targetName, '?');
      const error = text(after.error, '?');
      return {
        title: t(lang, 'route.down.title', { hostname }),
        summary: clip(t(lang, 'route.down.summary', { hostname }), 200),
        summaryDetail: clip(error, 300),
        body: t(lang, 'route.down.body', { hostname, application, machine, error }),
        fields: fieldsOf([
          [t(lang, 'field.domain'), hostname],
          [t(lang, 'field.application'), application],
          [t(lang, 'field.machine'), machine],
          [t(lang, 'field.error'), error],
        ]),
        path: entry.resourceId ? `/applications/${entry.resourceId}` : '/applications',
      };
    },
  },
  'route.recovered': {
    key: 'route.recovered',
    severity: 'info',
    auditAction: 'route.recovered',
    digestPath: '/applications',
    matches: () => true,
    dedupDiscriminator: (entry) => optional(record(entry.after).hostname),
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const hostname = text(after.hostname, '?');
      const application = text(after.application, '?');
      const machine = text(after.targetName, '?');
      return {
        title: t(lang, 'route.recovered.title', { hostname }),
        summary: clip(t(lang, 'route.recovered.summary', { hostname }), 200),
        summaryDetail: clip(`${application} · ${machine}`, 300),
        body: t(lang, 'route.recovered.body', { hostname, application, machine }),
        fields: fieldsOf([
          [t(lang, 'field.domain'), hostname],
          [t(lang, 'field.application'), application],
          [t(lang, 'field.machine'), machine],
        ]),
        path: entry.resourceId ? `/applications/${entry.resourceId}` : '/applications',
      };
    },
  },
} as const satisfies Record<NotificationEventKey, NotificationEventDescriptor>;

export function notificationEventDescriptor(key: NotificationEventKey): NotificationEventDescriptor {
  return CATALOG[key];
}

export function notificationEventDescriptors(): NotificationEventDescriptor[] {
  return NOTIFICATION_EVENT_KEYS.map((key) => CATALOG[key]);
}

export function isNotificationEventKey(value: unknown): value is NotificationEventKey {
  return typeof value === 'string' && Object.hasOwn(CATALOG, value);
}

/**
 * Le libellé d'un événement, dans la langue de l'instance. C'est ce que le
 * titre d'un résumé reprend — « 12 × Déploiement en échec ».
 */
export function notificationEventLabel(
  key: NotificationEventKey,
  language: UiLanguage = DEFAULT_UI_LANGUAGE,
): string {
  return t(language, `${key}.label`);
}

/**
 * Le catalogue sans ses fonctions, donc sérialisable vers l'écran.
 *
 * Les trois textes sont rendus ici, une fois, dans la langue de l'instance :
 * l'écran de configuration reçoit des phrases, pas des clés à résoudre.
 */
export type PresentedNotificationEvent = {
  readonly key: NotificationEventKey;
  readonly label: string;
  readonly description: string;
  readonly rationale: string;
  readonly severity: NotificationSeverity;
};

export function presentNotificationEvents(
  language: UiLanguage = DEFAULT_UI_LANGUAGE,
): PresentedNotificationEvent[] {
  return notificationEventDescriptors().map(({ key, severity }) => ({
    key,
    label: t(language, `${key}.label`),
    description: t(language, `${key}.description`),
    rationale: t(language, `${key}.rationale`),
    severity,
  }));
}

/**
 * Reconnaît un événement notifiable dans une entrée d'audit. `null` pour tout
 * le reste, c'est-à-dire pour l'immense majorité des entrées.
 *
 * Cette fonction est appelée **à chaque écriture d'audit** : elle doit rester
 * une comparaison de chaînes, sans accès réseau ni base.
 */
/**
 * Le discriminant d'anti-doublon d'une entrée, ou `null` si son descripteur
 * n'en fournit pas. Lu par la distribution, qui n'a pas à connaître le
 * catalogue.
 */
export function notificationDedupDiscriminator(
  key: NotificationEventKey,
  entry: NotifiableAuditEntry,
): string | null {
  // Passage par le type large : `CATALOG` est figé en `as const`, donc son type
  // est l'union des littéraux, et seuls deux d'entre eux portent ce champ
  // facultatif. L'élargir ici est ce que `satisfies` garantit déjà valide.
  const descriptor: NotificationEventDescriptor = CATALOG[key];
  return descriptor.dedupDiscriminator?.(entry) ?? null;
}

export function notifiableEventFor(entry: NotifiableAuditEntry): NotificationEventKey | null {
  for (const key of NOTIFICATION_EVENT_KEYS) {
    const descriptor = CATALOG[key];
    if (descriptor.auditAction === entry.action && descriptor.matches(entry)) return key;
  }
  return null;
}

/** Compose le message neutre. Aucun protocole n'est connu ici. */
export function buildNotificationMessage(
  key: NotificationEventKey,
  entry: NotifiableAuditEntry,
  ctx: NotificationRenderContext,
): NotificationMessage {
  const descriptor = CATALOG[key];
  const rendered = descriptor.render(entry, ctx);
  const base = ctx.panelUrl?.replace(/\/+$/, '') ?? null;

  return notificationMessageSchema.parse({
    event: key,
    severity: descriptor.severity,
    title: rendered.title,
    body: rendered.body,
    fields: rendered.fields,
    url: base && rendered.path ? `${base}${rendered.path}` : null,
    instance: ctx.instance,
    occurredAt: ctx.occurredAt,
    // La langue voyage **avec** le message, jusque dans la charge utile de la
    // tâche de remise. Un canal ajoute ses propres mots — « Ouvrir dans le
    // panel », la gravité en toutes lettres, « et 42 autres » — parfois
    // plusieurs minutes après la composition ; sans ce champ, il les écrirait
    // dans une autre langue que le corps qu'il encadre.
    language: ctx.language,
  });
}

/**
 * La ligne que cet événement occupera dans un résumé.
 *
 * Elle est composée **au moment où l'événement est retenu**, pas au moment du
 * résumé : l'entrée d'audit est là, l'acteur est résolu, le contexte est frais.
 * La différer voudrait dire recopier la charge utile d'audit en base pour la
 * relire une demi-heure plus tard — plus de stockage, pour une ligne qu'on sait
 * déjà écrire.
 */
export function buildNotificationDigestItem(
  key: NotificationEventKey,
  entry: NotifiableAuditEntry,
  ctx: NotificationRenderContext,
): NotificationDigestItem {
  const descriptor = CATALOG[key];
  const rendered = descriptor.render(entry, ctx);
  const base = ctx.panelUrl?.replace(/\/+$/, '') ?? null;

  // Second filet, en plus de celui posé par chaque `render`. Un dépassement de
  // borne ferait lever le `parse()` — donc échouer la tâche de distribution,
  // donc perdre l'alerte. Tronquer est toujours préférable à se taire.
  return notificationDigestItemSchema.parse({
    occurredAt: ctx.occurredAt,
    label: clip(rendered.summary, 200),
    detail: rendered.summaryDetail === null ? null : clip(rendered.summaryDetail, 300),
    url: base && rendered.path ? `${base}${rendered.path}` : null,
  });
}

/** Écran du panel vers lequel pointe un résumé de cet événement. */
export function notificationDigestPath(key: NotificationEventKey): string | null {
  return CATALOG[key].digestPath;
}
