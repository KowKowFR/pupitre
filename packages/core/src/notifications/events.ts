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
import type { MaintenanceRule } from '../maintenance.js';
import {
  describeForecast,
  forecastSchema,
  forecastSeverityLabel,
  forecastSubjectPath,
} from '../forecast.js';

/**
 * What deserves a notification — and nothing else.
 *
 * ── Why so few events ───────────────────────────────────────────────────────
 * The audit log records some sixty actions. Notifying even a quarter of them
 * would make the inbox unusable within a day, and the operator's first move
 * would be to turn the feature off — that is, to no longer be warned of
 * *anything*. Only a few events are kept, all answering the same question:
 * "does someone need to get up?"
 *
 *   deployment.failed         a release did not succeed
 *   deployment.scan_blocked   a vulnerable image was stopped before the release
 *   deployment.rolled_back    the panel went back by itself to the previous version
 *   deployment.succeeded      a version is online — only pick it where you want to see it go by
 *   security.two_factor_reset an account protection was lifted
 *   security.role_changed     someone gained or lost rights
 *   security.signup_pending   an account signed up and waits for a role to be chosen
 *   security.api_token_created an API token was created: an access that acts without a browser
 *   security.host_key_changed a target presents another host key: connection refused
 *   monitor.down              a monitored site went down, outage confirmed
 *   monitor.recovered         that site came back
 *   image.update.available    a deployed image was republished, or overtaken
 *   backup.failed             a backup did not succeed
 *   route.down                a domain no longer answers through its reverse proxy
 *   route.recovered           that domain answers again
 *   route.certificate_expiring a domain's certificate expires in under fourteen days
 *   route.certificate_renewed  that certificate was renewed
 *   target.unreachable        a machine no longer answers over SSH, two readings in a row
 *   target.reachable          that machine answers again
 *
 * Deliberately left out: permission refusals (chatty and already traced) and
 * periodic readings. A success wakes nobody up either — but a team sometimes
 * wants to see its releases go by in its room: `deployment.succeeded` exists for
 * it. Like any event, it only goes to the channels that chose it.
 *
 * ── Why monitoring comes in here, when it had its own webhook ───────────────
 * Probes could already alert, but each one to **its** webhook, set probe by
 * probe. A site could therefore go down without anybody learning it, on an
 * instance that does have a working Discord channel. Going through the catalog
 * gives them for free what the notification layer already does: the four
 * protocols, burst grouping, named digests, per-channel replay. The per-probe
 * webhook stays — see below.
 *
 * ── What monitoring does NOT send ───────────────────────────────────────────
 * A probe moves between `healthy`, `unhealthy` and `unreachable`. Not all flips
 * are equal, and it is the state machine that decides, not this file:
 * `nextMonitorState()` only announces a transition after `failureThreshold`
 * consecutive failures (opening) or `recoveryThreshold` consecutive successes
 * (closing), and **none** when a probe already down goes from "answering
 * badly" to "unreachable". Hysteresis therefore exists upstream of the audit: a
 * blip writes no entry, hence produces no event. There is nothing to filter
 * again here, and above all nothing to reinvent.
 *
 * ── Why a single `monitor.down` and not two ─────────────────────────────────
 * Separating "answering badly" from "unreachable" would give two events, hence
 * two grouping buckets, hence two digests for one infrastructure outage that
 * produces a mix of 503s and refused connections. The nature of the outage
 * belongs to the *content* of the message and of the digest line, not to the
 * key — the same trade-off as `notificationDigestGroupKey()`.
 *
 * ── Why the source is the audit log ─────────────────────────────────────────
 * These events **already** go through `logAudit()`, the single entry point of
 * traceability. Describing them again by hand at each emission site would mean
 * changing the deployment pipeline, two administration routes and the worker —
 * and starting over at the next event. By deriving from an audit entry, the
 * mapping "what happened" → "what we send" fits in this single table, and
 * nothing upstream moves.
 *
 * Monitoring proved it: probes already wrote `monitor.down` /
 * `monitor.recovered` to `audit_logs`. Plugging them into the channels took
 * **no** line in `apps/worker/src/monitors` apart from enriching the audit
 * payload — two entries here were enough.
 *
 * An accepted corollary: an event that is not audited cannot be notified. It is
 * a good constraint — an incident that leaves no trace should not exist.
 */

export const NOTIFICATION_EVENT_KEYS = [
  'deployment.failed',
  'deployment.scan_blocked',
  'deployment.rolled_back',
  'deployment.succeeded',
  'security.two_factor_reset',
  'security.role_changed',
  'security.signup_pending',
  'security.api_token_created',
  'security.host_key_changed',
  'monitor.down',
  'monitor.recovered',
  'target.threshold.breached',
  'target.threshold.cleared',
  'target.unreachable',
  'target.reachable',
  'image.update.available',
  'backup.failed',
  'route.down',
  'route.recovered',
  'route.certificate_expiring',
  'route.certificate_renewed',
  'forecast.raised',
  'maintenance.started',
  'maintenance.ended',
] as const;

export type NotificationEventKey = (typeof NOTIFICATION_EVENT_KEYS)[number];

/**
 * An alert's words, in both languages.
 *
 * ── Why the dictionary is here and not in `apps/web` ────────────────────────
 * Nobody is in front of the screen when this text is written. There is no
 * session, no request, no component: it is the worker that composes, at three
 * in the morning, in reaction to an audit entry. The dictionary therefore lives
 * next to what it describes, as the rule set in `i18n.ts` wants — interface
 * dictionaries in the panel, the domain's next to the domain.
 *
 * ── Where the language comes from ───────────────────────────────────────────
 * From `settings.locale`, through `languageOf()`, resolved by the caller and
 * passed down in `NotificationRenderContext`. `packages/core` does not depend
 * on `@pupitre/db` and will therefore never read it itself. It is the same
 * constraint that made `panelUrl` and `instance` go through this context.
 *
 * ── What is not translated ──────────────────────────────────────────────────
 * Event keys, audit action names, resource identifiers, slugs and URLs. They
 * are data, not sentences.
 */
const fr = {
  // ── shared vocabulary ──────────────────────────────────────────────────
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

  // ── field labels ───────────────────────────────────────────────────────
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

  // ── monitoring vocabulary ──────────────────────────────────────────────
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
  'security.signup_pending.bodySso':
    'Le compte {account} vient d’être créé à sa première connexion par {provider}. Il n’a accès à rien ' +
    'tant qu’un administrateur ne lui a pas attribué de rôle.',

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

  // ── route.certificate_expiring / route.certificate_renewed ─────────────
  'route.certificate_expiring.label': 'Certificat bientôt échu',
  'route.certificate_expiring.description':
    'Le certificat d’un domaine expire dans moins de quatorze jours : son renouvellement automatique n’a pas abouti.',
  'route.certificate_expiring.rationale':
    'Let’s Encrypt renouvelle trente jours avant l’échéance. À quatorze, quelque chose bloque — le DNS, le port 80, une limite de l’autorité — et il reste le temps de le régler avant que les navigateurs refusent le site.',
  'route.certificate_expiring.title': 'Certificat bientôt échu — {hostname}',
  'route.certificate_expiring.body':
    'Le certificat de « {hostname} » ({application}, sur « {machine} ») expire le {date}, dans {days} jour(s). Son renouvellement automatique n’a pas abouti.',
  'route.certificate_expiring.summary': '{hostname} — expire le {date}',
  'route.certificate_renewed.label': 'Certificat renouvelé',
  'route.certificate_renewed.description':
    'Un certificat signalé comme bientôt échu a été renouvelé.',
  'route.certificate_renewed.rationale':
    'Ferme l’alerte reçue plus tôt : le domaine a de nouveau un certificat valable.',
  'route.certificate_renewed.title': 'Certificat renouvelé — {hostname}',
  'route.certificate_renewed.body':
    'Le certificat de « {hostname} » ({application}, sur « {machine} ») est renouvelé jusqu’au {date}.',
  'route.certificate_renewed.summary': '{hostname} — jusqu’au {date}',

  // ── maintenance.started / maintenance.ended ──────────────────────────────
  'maintenance.started.label': 'Maintenance commencée',
  'maintenance.started.description':
    'Une fenêtre de maintenance commence : les alertes de supervision de ses cibles et de ses sondes sont retenues jusqu’à sa fin.',
  'maintenance.started.rationale':
    'Que l’équipe sache que le silence est voulu, et jusqu’à quand. Rien n’est perdu : ce qui sera encore en panne à la fin partira à ce moment-là.',
  'maintenance.started.title': 'Maintenance commencée — {title}',
  'maintenance.started.summary': '{subjects}, jusqu’au {end}',
  'maintenance.started.body':
    'La maintenance « {title} » a commencé : {subjects}. Jusqu’au {end}, leurs alertes de supervision sont retenues ; ce qui sera encore en panne à la fin partira à ce moment-là.',
  'maintenance.bodyNote': ' Note : {note}',
  'maintenance.ended.label': 'Maintenance terminée',
  'maintenance.ended.description':
    'Une fenêtre de maintenance se termine : les alertes reprennent, et ce qui est resté en panne est annoncé.',
  'maintenance.ended.rationale':
    'Une panne apparue pendant la maintenance et toujours là à sa fin ne doit pas rester silencieuse : elle part avec ce message, et sur les canaux de son propre événement.',
  'maintenance.ended.title': 'Maintenance terminée — {title}',
  'maintenance.ended.summaryFailing': {
    one: '{count} problème toujours là',
    other: '{count} problèmes toujours là',
  },
  'maintenance.ended.summaryClear': 'tout est rentré dans l’ordre',
  'maintenance.ended.body':
    'La maintenance « {title} » est terminée ({held} alerte(s) retenue(s)).',
  'maintenance.ended.bodyFailing': ' Toujours en panne, annoncé maintenant : {list}.',
  'maintenance.ended.bodyClear': ' Rien n’est resté en panne.',
  'field.maintenance': 'Maintenance',
  'field.covers': 'Couvre',
  'field.until': 'Jusqu’au',
  'field.held': 'Alertes retenues',
  'field.stillFailing': 'Toujours en panne',

  // ── forecast.raised ────────────────────────────────────────────────────
  'forecast.raised.label': 'Prévision : un problème en vue',
  'forecast.raised.description':
    'Le panel voit venir une panne : un disque qui se remplit, une mémoire qui ne redescend pas, une charge en hausse, une sonde qui ralentit ou qui bascule, un certificat non renouvelé, une sauvegarde en retard, des déploiements qui échouent en série.',
  'forecast.raised.rationale':
    'Prévenir avant que ça casse : chaque prévision est un calcul sur les relevés que le panel garde déjà (une pente, une médiane, un compte), refait toutes les 30 minutes. Elle n’est annoncée qu’une fois, à son apparition.',
  'forecast.raised.title': '{title} — {name}',
  'forecast.raised.bodyEta': ' Échéance estimée : {date}.',
  'field.forecast': 'Prévision',
  'field.eta': 'Échéance estimée',

  // ── target.unreachable / target.reachable ──────────────────────────────
  'target.unreachable.label': 'Machine injoignable',
  'target.unreachable.description':
    'Pupitre ne joint plus une machine en SSH : deux relevés de suite ont échoué.',
  'target.unreachable.rationale':
    'Une machine éteinte ne franchit aucun seuil : sans cet événement, elle tombe en silence. Deux relevés manqués et non un seul — un redémarrage ne réveille personne.',
  'target.unreachable.title': 'Machine injoignable — {machine}',
  'target.unreachable.body':
    'Pupitre ne joint plus « {machine} » ({host}) depuis {duration} : {error}',
  'target.unreachable.summary': '{machine}',
  'target.reachable.label': 'Machine de nouveau joignable',
  'target.reachable.description': 'Une machine injoignable répond de nouveau.',
  'target.reachable.rationale':
    'Ferme l’alerte reçue plus tôt, et dit combien de temps l’interruption a duré.',
  'target.reachable.title': 'Machine joignable — {machine}',
  'target.reachable.body':
    '« {machine} » ({host}) répond de nouveau, après {duration} d’interruption.',
  'target.reachable.summary': '{machine}',
  'field.host': 'Adresse',

  // ── deployment.succeeded ───────────────────────────────────────────────
  'deployment.succeeded.label': 'Déploiement réussi',
  'deployment.succeeded.description':
    'Une version est en ligne : le pipeline est allé au bout et la santé répond.',
  'deployment.succeeded.rationale':
    'Un succès ne réveille personne : à choisir pour le salon de l’équipe qui veut voir passer ses mises en ligne, pas pour la boîte de l’astreinte.',
  'deployment.succeeded.title': 'Déployé — {application}',
  'deployment.succeeded.body':
    '« {application} » version {version} est en ligne sur « {machine} »{url}.',
  'deployment.succeeded.bodyUrl': ' : {url}',
  'deployment.succeeded.summary': '{application} — version {version}',
  'field.version': 'Version',
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
  'security.signup_pending.bodySso':
    'Account {account} was just created on its first sign-in through {provider}. It can reach nothing ' +
    'until an administrator assigns it a role.',

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

  'route.certificate_expiring.label': 'Certificate expiring soon',
  'route.certificate_expiring.description':
    'A domain’s certificate expires in less than fourteen days: its automatic renewal did not go through.',
  'route.certificate_expiring.rationale':
    'Let’s Encrypt renews thirty days before expiry. At fourteen, something is in the way — DNS, port 80, an authority limit — and there is still time to fix it before browsers refuse the site.',
  'route.certificate_expiring.title': 'Certificate expiring soon — {hostname}',
  'route.certificate_expiring.body':
    'The certificate of “{hostname}” ({application}, on “{machine}”) expires on {date}, in {days} day(s). Its automatic renewal did not go through.',
  'route.certificate_expiring.summary': '{hostname} — expires {date}',
  'route.certificate_renewed.label': 'Certificate renewed',
  'route.certificate_renewed.description': 'A certificate reported as expiring soon was renewed.',
  'route.certificate_renewed.rationale':
    'Closes the earlier alert: the domain has a valid certificate again.',
  'route.certificate_renewed.title': 'Certificate renewed — {hostname}',
  'route.certificate_renewed.body':
    'The certificate of “{hostname}” ({application}, on “{machine}”) is renewed until {date}.',
  'route.certificate_renewed.summary': '{hostname} — until {date}',

  'maintenance.started.label': 'Maintenance started',
  'maintenance.started.description':
    'A maintenance window starts: monitoring alerts for its targets and probes are held until it ends.',
  'maintenance.started.rationale':
    'Let the team know the silence is deliberate, and until when. Nothing is lost: whatever is still down at the end is sent then.',
  'maintenance.started.title': 'Maintenance started — {title}',
  'maintenance.started.summary': '{subjects}, until {end}',
  'maintenance.started.body':
    'Maintenance “{title}” has started: {subjects}. Until {end}, their monitoring alerts are held; whatever is still down at the end is sent then.',
  'maintenance.bodyNote': ' Note: {note}',
  'maintenance.ended.label': 'Maintenance ended',
  'maintenance.ended.description':
    'A maintenance window ends: alerts resume, and whatever stayed down is announced.',
  'maintenance.ended.rationale':
    'An outage that appeared during maintenance and is still there at the end must not stay silent: it is sent with this message, and on its own event’s channels.',
  'maintenance.ended.title': 'Maintenance ended — {title}',
  'maintenance.ended.summaryFailing': {
    one: '{count} problem still there',
    other: '{count} problems still there',
  },
  'maintenance.ended.summaryClear': 'everything is back to normal',
  'maintenance.ended.body': 'Maintenance “{title}” has ended ({held} alert(s) held).',
  'maintenance.ended.bodyFailing': ' Still down, announced now: {list}.',
  'maintenance.ended.bodyClear': ' Nothing stayed down.',
  'field.maintenance': 'Maintenance',
  'field.covers': 'Covers',
  'field.until': 'Until',
  'field.held': 'Alerts held',
  'field.stillFailing': 'Still down',

  'forecast.raised.label': 'Forecast: a problem ahead',
  'forecast.raised.description':
    'The panel sees an outage coming: a disk filling up, memory that never comes back down, rising load, a monitor slowing down or flapping, a certificate not renewed, an overdue backup, deployments failing in a row.',
  'forecast.raised.rationale':
    'Warn before it breaks: each forecast is a calculation on readings the panel already keeps (a slope, a median, a count), redone every 30 minutes. It is announced once, when it appears.',
  'forecast.raised.title': '{title} — {name}',
  'forecast.raised.bodyEta': ' Estimated deadline: {date}.',
  'field.forecast': 'Forecast',
  'field.eta': 'Estimated deadline',

  'target.unreachable.label': 'Machine unreachable',
  'target.unreachable.description':
    'Pupitre no longer reaches a machine over SSH: two readouts in a row failed.',
  'target.unreachable.rationale':
    'A machine that is off crosses no threshold: without this event, it goes down silently. Two missed readouts, not one — a reboot wakes nobody up.',
  'target.unreachable.title': 'Machine unreachable — {machine}',
  'target.unreachable.body': 'Pupitre has not reached “{machine}” ({host}) for {duration}: {error}',
  'target.unreachable.summary': '{machine}',
  'target.reachable.label': 'Machine reachable again',
  'target.reachable.description': 'An unreachable machine answers again.',
  'target.reachable.rationale': 'Closes the earlier alert, and says how long the outage lasted.',
  'target.reachable.title': 'Machine reachable — {machine}',
  'target.reachable.body': '“{machine}” ({host}) answers again, after {duration} of outage.',
  'target.reachable.summary': '{machine}',
  'field.host': 'Address',

  'deployment.succeeded.label': 'Deployment succeeded',
  'deployment.succeeded.description':
    'A version is live: the pipeline went all the way and the health check answers.',
  'deployment.succeeded.rationale':
    'A success wakes nobody up: pick it for the team room that wants to see releases go by, not for the on-call inbox.',
  'deployment.succeeded.title': 'Deployed — {application}',
  'deployment.succeeded.body': '“{application}” version {version} is live on “{machine}”{url}.',
  'deployment.succeeded.bodyUrl': ': {url}',
  'deployment.succeeded.summary': '{application} — version {version}',
  'field.version': 'Version',
  'field.trigger': 'Trigger',
  'backup.trigger.schedule': 'scheduled',
  'backup.trigger.manual': 'on demand',
  'backup.trigger.pre_deploy': 'before deployment',
  'backup.trigger.pre_restore': 'before restore',
};

const EVENT_TEXT = { fr, en };

/**
 * Each event of the catalog carries its three presentation texts. The compiler
 * checks it here rather than at runtime: an event added without a label does
 * not compile.
 */
const _eventTextParity: Record<
  `${NotificationEventKey}.${'label' | 'description' | 'rationale'}`,
  string
> = fr;
void _eventTextParity;

function t(language: UiLanguage, key: keyof typeof fr, vars?: Vars): string {
  return renderMessage(EVENT_TEXT, language, key, vars);
}

/** The audit entry, reduced to what the mapping needs. */
export type NotifiableAuditEntry = {
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorId: string | null;
  before: unknown;
  after: unknown;
};

/** What the emitter knows of its own context at composition time. */
export type NotificationRenderContext = {
  /** The instance's name, as the settings carry it. */
  instance: string;
  /** The panel's root, without a trailing slash. `null` if it is not known. */
  panelUrl: string | null;
  /** The actor's email, when it could be resolved. `null` for the system. */
  actor: string | null;
  occurredAt: string;
  /**
   * The instance's language, taken from `settings.locale` by `languageOf()`.
   *
   * It comes down as a parameter because `packages/core` does not depend on
   * `@pupitre/db` and therefore cannot read the settings: it is the caller — the
   * worker, or the panel for a channel test — that resolves it. The same pattern
   * as `panelUrl` and `instance`.
   */
  language: UiLanguage;
};

type RenderedEvent = {
  title: string;
  body: string;
  fields: NotificationField[];
  /** Path relative to the panel, e.g. `/deployments/xxx`. `null` if there is none. */
  path: string | null;
  /**
   * What a **digest line** names, when this event is grouped with others of the
   * same type. Required, on purpose: it is this line that keeps a digest from
   * being a mute counter. It names the object concerned — "deployment 4f2a…",
   * "account alice@…" — never the category, which is already in the digest's
   * title.
   */
  summary: string;
  /** A short detail of the digest line: the step, the verdict, the transition. */
  summaryDetail: string | null;
};

/**
 * The descriptor no longer carries its texts: they live in the dictionary
 * above, under the `<event>.label`, `.description` and `.rationale` keys. A
 * descriptor is structure — a severity, an audit action, a path —, and
 * structure has no language. The texts are read through
 * `notificationEventLabel()` and `presentNotificationEvents()`, which both take
 * the language.
 */
export type NotificationEventDescriptor = {
  readonly key: NotificationEventKey;
  readonly severity: NotificationSeverity;
  /** Audit action that carries the event. */
  readonly auditAction: string;
  /**
   * Panel screen showing *all* of these objects. A digest carries several
   * objects: it cannot point to one of them's record.
   */
  readonly digestPath: string | null;
  /**
   * Tells apart two events carried by the same audit action. A scan that blocks
   * and a deployment that breaks are both written `deployment.failed`: only
   * `failedStep` distinguishes them.
   */
  readonly matches: (entry: NotifiableAuditEntry) => boolean;
  readonly render: (entry: NotifiableAuditEntry, ctx: NotificationRenderContext) => RenderedEvent;
  /**
   * What distinguishes **two successive occurrences** of the same event on the
   * same object, when the resource's identifier is not enough.
   *
   * The dispatch's deduplication covers the (event, resource) pair for five
   * minutes. For a deployment, that goes without saying: each deployment has its
   * identifier, and the window only serves to absorb the three attempts BullMQ
   * writes for one incident.
   *
   * For a probe, no. The identifier is the **probe's**, stable from one outage to
   * the next: two distinct outages of the same site less than five minutes apart
   * were merged, and the second alert was swallowed without a trace. A
   * descriptor can therefore provide here a discriminant taken from its payload
   * — the incident identifier, typically — which separates occurrences without
   * changing anything about absorbing replays, since a replay copies the same
   * payload.
   *
   * `undefined` keeps the original behavior.
   */
  readonly dedupDiscriminator?: (entry: NotifiableAuditEntry) => string | null;
  /**
   * How the alert is filed during a maintenance window: its subject, its family,
   * whether it opens a problem. Absent: the event is never held — security,
   * deployments, backups always go through.
   */
  readonly maintenance?: MaintenanceRule;
};

// ─── defensive reading of audit payloads ──────────────────────────────────────

/**
 * `before` and `after` are JSONB: nothing guarantees their shape. A
 * notification must never fail because a field moved — at worst it is less
 * precise.
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

/** Only adds a field if it has a value — a "—" line teaches nothing. */
function fieldsOf(entries: [string, string | null][]): NotificationField[] {
  return entries
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([label, value]) => ({ label, value }));
}

function actorField(ctx: NotificationRenderContext): [string, string | null] {
  return [t(ctx.language, 'actor.label'), ctx.actor ?? t(ctx.language, 'actor.system')];
}

/**
 * Caps a string, saying so.
 *
 * `notificationDigestItemSchema` caps `label` at 200 characters and `detail` at
 * 300: beyond that, `parse()` **throws**, the dispatch task fails and the alert
 * is lost. It is not theoretical — a probe URL is accepted up to 2,048
 * characters. A truncated digest line is a nuisance; an outage alert that never
 * left is an outage.
 */
function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// ─── monitoring vocabulary ────────────────────────────────────────────────────

/**
 * A probe's verdict. It lives here and not in a `switch` in the caller: it is
 * message formatting, and `message.ts` forbids it from leaking elsewhere.
 *
 * The `switch` is on the **status**, which is data, and returns a dictionary
 * key. That is what keeps a single mapping table whatever the language.
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
 * The same verdict, but as a predicate.
 *
 * Two functions and not one, because French does not concatenate: « est
 * injoignable » is said with the verb "to be", « répond mal » carries its own.
 * Sticking an `est ${verdict}` in front of the adjective gave « est répond
 * mal ». Observed at the first run, not assumed. English has exactly the same
 * problem (*is unreachable* versus *answers normally*), hence the same pair of
 * keys.
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

/** "4 min", "1 h 20", "2 d". `null` when the duration is not known. */
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
 * What identifies the probe in a digest line.
 *
 * The name **and** the target, because they are not the same information: the
 * operator named the probe ("shop"), but it is the URL that says which of the
 * three shops went down. A digest of twelve outages must be readable without
 * opening the panel.
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

// ─── the alerts a maintenance window holds ────────────────────────────────────

/** A probe: the outage and the recovery of one probe form a family. */
const monitorRule = (opens: boolean): MaintenanceRule => ({
  subject: (entry) => (entry.resourceId ? { type: 'monitor', id: entry.resourceId } : null),
  family: (entry) => `monitor:${entry.resourceId ?? '?'}`,
  opens,
});

/** A machine unreachable, then reached again. */
const reachabilityRule = (opens: boolean): MaintenanceRule => ({
  subject: (entry) => (entry.resourceId ? { type: 'target', id: entry.resourceId } : null),
  family: (entry) => `reach:${entry.resourceId ?? '?'}`,
  opens,
});

/** A machine's threshold: each metric is its own family. */
const thresholdRule = (opens: boolean): MaintenanceRule => ({
  subject: (entry) => (entry.resourceId ? { type: 'target', id: entry.resourceId } : null),
  family: (entry) =>
    `threshold:${entry.resourceId ?? '?'}:${optional(record(entry.after).metric) ?? '?'}`,
  opens,
});

/**
 * A domain: the entry is in the application's name, the route is in the
 * payload. An old entry without `routeId` is never held.
 */
const routeRule = (opens: boolean): MaintenanceRule => ({
  subject: (entry) => {
    const routeId = optional(record(entry.after).routeId);
    return routeId ? { type: 'route', id: routeId } : null;
  },
  family: (entry) => `route:${optional(record(entry.after).routeId) ?? '?'}`,
  opens,
});

/** "2026-10-03T22:00:00.000Z" → "2026-10-03 22:00 UTC". */
function utcMinute(value: unknown): string {
  const iso = optional(value);
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : '?';
}

/** The names of a payload list, joined for a sentence. */
function names(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => text(item, '?')) : [];
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
        // Two versions and an arrow: not a sentence, nothing to translate.
        summaryDetail: `${text(before.version, '?')} → ${text(after.restoredVersion, '?')}`,
      };
    },
  },
  'deployment.succeeded': {
    key: 'deployment.succeeded',
    severity: 'info',
    auditAction: 'deployment.succeeded',
    digestPath: '/deployments',
    matches: () => true,
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const application = text(after.application, '?');
      const machine = text(after.targetName, '?');
      const version = text(after.version, '?');
      const url = optional(after.url);
      return {
        title: t(lang, 'deployment.succeeded.title', { application }),
        body: t(lang, 'deployment.succeeded.body', {
          application,
          version,
          machine,
          url: url ? t(lang, 'deployment.succeeded.bodyUrl', { url }) : '',
        }),
        fields: fieldsOf([
          [t(lang, 'field.application'), application],
          [t(lang, 'field.version'), version],
          [t(lang, 'field.machine'), machine],
          [t(lang, 'field.url'), url],
          actorField(ctx),
        ]),
        path: entry.resourceId ? `/deployments/${entry.resourceId}` : null,
        summary: t(lang, 'deployment.succeeded.summary', { application, version }),
        summaryDetail: machine,
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
    // The creation hook writes the role assigned. Only public sign-up gives the
    // no-access role: an account created by an administrator already carries the
    // role they chose, it waits for nobody.
    matches: (entry) => record(entry.after).role === SIGNUP_ROLE,
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const account = text(after.email, entry.resourceId ?? '?');
      return {
        title: t(lang, 'security.signup_pending.title', { account }),
        body:
          after.origin === 'sso'
            ? t(lang, 'security.signup_pending.bodySso', {
                account,
                provider: text(after.provider, '?'),
              })
            : t(lang, 'security.signup_pending.body', { account }),
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
    // One unexpected key per message: the worker only writes it once per key.
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
    maintenance: monitorRule(true),
    digestPath: '/monitors',
    // A single audit action carries this event, and the state machine already set
    // blips aside: nothing to tell apart here.
    // Deduplication covers (event, resource), and a probe's resource is the probe
    // — the same from one outage to the next. Two distinct outages of the same site
    // less than five minutes apart were therefore merged, and the second alert
    // disappeared without a trace. The incident identifier separates them; a replay
    // of the same task copies it and stays absorbed.
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
        // The nature of the outage, not the category: it is what distinguishes "the
        // server returns 503" from "nothing listens on the port anymore".
        summaryDetail: clip(
          detail ? t(lang, 'monitor.down.summaryDetail', { verdict, detail }) : verdict,
          300,
        ),
      };
    },
  },
  'monitor.recovered': {
    key: 'monitor.recovered',
    // `info` and not `warning`: a recovery requires no gesture. Severity serves
    // routing and color; painting it red would teach people to ignore red.
    severity: 'info',
    auditAction: 'monitor.recovered',
    maintenance: monitorRule(false),
    digestPath: '/monitors',
    // Deduplication covers (event, resource), and a probe's resource is the probe
    // — the same from one outage to the next. Two distinct outages of the same site
    // less than five minutes apart were therefore merged, and the second alert
    // disappeared without a trace. The incident identifier separates them; a replay
    // of the same task copies it and stays absorbed.
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
    maintenance: thresholdRule(true),
    digestPath: '/apps',
    matches: () => true,
    // One episode per crossing, and its identifier does not move while it lasts:
    // two successive crossings of the same metric on the same machine are two
    // episodes, hence two messages. Without it, the resource would be the machine,
    // identical from one episode to the next.
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
    maintenance: thresholdRule(false),
    digestPath: '/apps',
    matches: () => true,
    dedupDiscriminator: (entry) => optional(record(entry.after).breachId),
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const machine = text(after.targetName, '?');
      const metrique = text(after.metricLabel, t(lang, 'target.threshold.cleared.metric'));
      const duree = optional(after.durationSeconds);
      // `threshold_disabled`: the episode closed because the threshold was turned
      // off, not because the machine is better. Keeping quiet about it would be false
      // relief — it is exactly the kind of message read quickly.
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
                  // `duree` comes out of `optional()`, so it is a string, and
                  // `monitorDuration()` only accepts a number: it has always
                  // returned `null` here. Behavior reproduced as is —
                  // fixing it is not the job of a translation.
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
  'target.unreachable': {
    key: 'target.unreachable',
    severity: 'critical',
    auditAction: 'target.unreachable',
    maintenance: reachabilityRule(true),
    digestPath: '/targets',
    matches: () => true,
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const machine = text(after.targetName, entry.resourceId ?? '?');
      const host = text(after.host, '?');
      const duration = monitorDuration(lang, after.downSeconds) ?? '?';
      const error = text(after.error, '?');
      return {
        title: t(lang, 'target.unreachable.title', { machine }),
        body: t(lang, 'target.unreachable.body', { machine, host, duration, error }),
        fields: fieldsOf([
          [t(lang, 'field.machine'), machine],
          [t(lang, 'field.host'), host],
          [t(lang, 'field.consecutiveFailures'), optional(after.failures)],
          [t(lang, 'field.error'), error],
        ]),
        path: entry.resourceId ? `/targets/${entry.resourceId}` : '/targets',
        summary: t(lang, 'target.unreachable.summary', { machine }),
        summaryDetail: clip(error, 300),
      };
    },
  },
  'target.reachable': {
    key: 'target.reachable',
    severity: 'info',
    auditAction: 'target.reachable',
    maintenance: reachabilityRule(false),
    digestPath: '/targets',
    matches: () => true,
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const machine = text(after.targetName, entry.resourceId ?? '?');
      const host = text(after.host, '?');
      const duration = monitorDuration(lang, after.downSeconds) ?? '?';
      return {
        title: t(lang, 'target.reachable.title', { machine }),
        body: t(lang, 'target.reachable.body', { machine, host, duration }),
        fields: fieldsOf([
          [t(lang, 'field.machine'), machine],
          [t(lang, 'field.host'), host],
          [t(lang, 'field.outageDuration'), duration],
        ]),
        path: entry.resourceId ? `/targets/${entry.resourceId}` : '/targets',
        summary: t(lang, 'target.reachable.summary', { machine }),
        summaryDetail: duration,
      };
    },
  },
  'image.update.available': {
    key: 'image.update.available',
    severity: 'warning',
    auditAction: 'image.update.available',
    digestPath: '/applications',
    matches: () => true,
    // The resource is the application, stable from one announcement to the next: it
    // is the novelty itself (digests, tags) that distinguishes two announcements.
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
    // The resource is the application (or the panel), stable from one night to the
    // next: it is the backup itself that distinguishes two failures.
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
    maintenance: routeRule(true),
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
    maintenance: routeRule(false),
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
  'route.certificate_expiring': {
    key: 'route.certificate_expiring',
    severity: 'warning',
    auditAction: 'route.certificate.expiring',
    digestPath: '/applications',
    matches: () => true,
    dedupDiscriminator: (entry) => optional(record(entry.after).hostname),
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const hostname = text(after.hostname, '?');
      const application = text(after.application, '?');
      const machine = text(after.targetName, '?');
      const date = text(after.notAfter, '?').slice(0, 10);
      const days = typeof after.daysLeft === 'number' ? after.daysLeft : '?';
      return {
        title: t(lang, 'route.certificate_expiring.title', { hostname }),
        summary: clip(t(lang, 'route.certificate_expiring.summary', { hostname, date }), 200),
        summaryDetail: optional(after.issuer),
        body: t(lang, 'route.certificate_expiring.body', {
          hostname,
          application,
          machine,
          date,
          days,
        }),
        fields: fieldsOf([
          [t(lang, 'field.domain'), hostname],
          [t(lang, 'field.application'), application],
          [t(lang, 'field.machine'), machine],
          [t(lang, 'field.expires'), date],
        ]),
        path: entry.resourceId ? `/applications/${entry.resourceId}` : '/applications',
      };
    },
  },
  'route.certificate_renewed': {
    key: 'route.certificate_renewed',
    severity: 'info',
    auditAction: 'route.certificate.renewed',
    digestPath: '/applications',
    matches: () => true,
    dedupDiscriminator: (entry) => optional(record(entry.after).hostname),
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const hostname = text(after.hostname, '?');
      const application = text(after.application, '?');
      const machine = text(after.targetName, '?');
      const date = text(after.notAfter, '?').slice(0, 10);
      return {
        title: t(lang, 'route.certificate_renewed.title', { hostname }),
        summary: clip(t(lang, 'route.certificate_renewed.summary', { hostname, date }), 200),
        summaryDetail: null,
        body: t(lang, 'route.certificate_renewed.body', { hostname, application, machine, date }),
        fields: fieldsOf([
          [t(lang, 'field.domain'), hostname],
          [t(lang, 'field.application'), application],
          [t(lang, 'field.expires'), date],
        ]),
        path: entry.resourceId ? `/applications/${entry.resourceId}` : '/applications',
      };
    },
  },
  'forecast.raised': {
    key: 'forecast.raised',
    severity: 'warning',
    auditAction: 'forecast.raised',
    digestPath: '/',
    matches: () => true,
    // One episode, one message: the episode's identifier does not move while the
    // forecast lasts, and a forecast closed then back is another one.
    dedupDiscriminator: (entry) => entry.resourceId ?? null,
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const name = text(after.subjectName, '?');
      const parsed = forecastSchema.safeParse({
        kind: after.kind,
        subject: { type: after.subjectType, id: text(after.subjectId, '?'), name },
        severity: after.severity,
        etaAt: optional(after.etaAt),
        detail: record(after.detail),
      });
      const described = parsed.success
        ? describeForecast(parsed.data, lang)
        : { title: t(lang, 'forecast.raised.label'), sentence: name };
      const eta = optional(after.etaAt);
      const date = eta === null ? null : String(eta).slice(0, 10);
      return {
        title: t(lang, 'forecast.raised.title', { title: described.title, name }),
        summary: clip(described.sentence, 200),
        summaryDetail: parsed.success ? forecastSeverityLabel(parsed.data.severity, lang) : null,
        body: described.sentence + (date ? t(lang, 'forecast.raised.bodyEta', { date }) : ''),
        fields: fieldsOf([
          [t(lang, 'field.forecast'), described.title],
          [
            t(lang, FORECAST_SUBJECT_FIELD[parsed.success ? parsed.data.subject.type : 'target']),
            name,
          ],
          [t(lang, 'field.eta'), date],
        ]),
        path: parsed.success ? forecastSubjectPath(parsed.data.subject) : '/',
      };
    },
  },
  'maintenance.started': {
    key: 'maintenance.started',
    severity: 'info',
    auditAction: 'maintenance.started',
    digestPath: '/maintenance',
    matches: () => true,
    dedupDiscriminator: (entry) => entry.resourceId ?? null,
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const title = text(after.title, '?');
      const subjects = [...names(after.targets), ...names(after.monitors)].join(', ') || '?';
      const end = utcMinute(after.endsAt);
      const note = optional(after.note);
      return {
        title: t(lang, 'maintenance.started.title', { title }),
        summary: clip(t(lang, 'maintenance.started.summary', { subjects, end }), 200),
        summaryDetail: null,
        body:
          t(lang, 'maintenance.started.body', { title, subjects, end }) +
          (note ? t(lang, 'maintenance.bodyNote', { note }) : ''),
        fields: fieldsOf([
          [t(lang, 'field.maintenance'), title],
          [t(lang, 'field.covers'), subjects],
          [t(lang, 'field.until'), end],
          actorField(ctx),
        ]),
        path: entry.resourceId ? `/maintenance?window=${entry.resourceId}` : '/maintenance',
      };
    },
  },
  'maintenance.ended': {
    key: 'maintenance.ended',
    severity: 'info',
    auditAction: 'maintenance.ended',
    digestPath: '/maintenance',
    matches: () => true,
    dedupDiscriminator: (entry) => entry.resourceId ?? null,
    render: (entry, ctx) => {
      const after = record(entry.after);
      const lang = ctx.language;
      const title = text(after.title, '?');
      const held = typeof after.held === 'number' ? after.held : 0;
      const released = names(after.released);
      return {
        title: t(lang, 'maintenance.ended.title', { title }),
        summary: clip(
          released.length > 0
            ? t(lang, 'maintenance.ended.summaryFailing', { count: released.length })
            : t(lang, 'maintenance.ended.summaryClear'),
          200,
        ),
        summaryDetail: null,
        body:
          t(lang, 'maintenance.ended.body', { title, held }) +
          (released.length > 0
            ? t(lang, 'maintenance.ended.bodyFailing', { list: released.join(' ; ') })
            : t(lang, 'maintenance.ended.bodyClear')),
        fields: fieldsOf([
          [t(lang, 'field.maintenance'), title],
          [t(lang, 'field.held'), String(held)],
          [t(lang, 'field.stillFailing'), released.length > 0 ? released.join(' ; ') : null],
        ]),
        path: entry.resourceId ? `/maintenance?window=${entry.resourceId}` : '/maintenance',
      };
    },
  },
} as const satisfies Record<NotificationEventKey, NotificationEventDescriptor>;

/** An event's maintenance rule, or `null` if it is never held. */
export function maintenanceRuleOf(key: NotificationEventKey): MaintenanceRule | null {
  const descriptor: NotificationEventDescriptor = CATALOG[key];
  return descriptor.maintenance ?? null;
}

/** The name of the field that carries a forecast's subject. */
const FORECAST_SUBJECT_FIELD = {
  target: 'field.target',
  monitor: 'field.probe',
  route: 'field.domain',
  application: 'field.application',
} as const;

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
 * An event's label, in the instance's language. It is what a digest's title
 * repeats — "12 × Deployment failed".
 */
export function notificationEventLabel(
  key: NotificationEventKey,
  language: UiLanguage = DEFAULT_UI_LANGUAGE,
): string {
  return t(language, `${key}.label`);
}

/**
 * The catalog without its functions, hence serializable to the screen.
 *
 * The three texts are rendered here, once, in the instance's language: the
 * configuration screen receives sentences, not keys to resolve.
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
 * Recognizes a notifiable event in an audit entry. `null` for everything else,
 * that is, for the vast majority of entries.
 *
 * This function is called **at every audit write**: it must stay a string
 * comparison, without network or database access.
 */
/**
 * An entry's deduplication discriminant, or `null` if its descriptor provides
 * none. Read by the dispatch, which does not have to know the catalog.
 */
export function notificationDedupDiscriminator(
  key: NotificationEventKey,
  entry: NotifiableAuditEntry,
): string | null {
  // Through the wide type: `CATALOG` is frozen `as const`, so its type is the
  // union of the literals, and only two of them carry this optional field.
  // Widening it here is what `satisfies` already guarantees valid.
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

/** Composes the neutral message. No protocol is known here. */
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
    // The language travels **with** the message, into the delivery task's
    // payload. A channel adds its own words — "Open in the panel", the severity
    // spelled out, "and 42 more" — sometimes several minutes after composition;
    // without this field, it would write them in another language than the body it
    // frames.
    language: ctx.language,
  });
}

/**
 * The line this event will take in a digest.
 *
 * It is composed **when the event is held**, not when the digest is: the audit
 * entry is there, the actor is resolved, the context is fresh. Deferring it
 * would mean copying the audit payload to the database to read it again half
 * an hour later — more storage, for a line we already know how to write.
 */
export function buildNotificationDigestItem(
  key: NotificationEventKey,
  entry: NotifiableAuditEntry,
  ctx: NotificationRenderContext,
): NotificationDigestItem {
  const descriptor = CATALOG[key];
  const rendered = descriptor.render(entry, ctx);
  const base = ctx.panelUrl?.replace(/\/+$/, '') ?? null;

  // A second safety net, on top of the one set by each `render`. Exceeding a bound
  // would make `parse()` throw — hence fail the dispatch task, hence lose the
  // alert. Truncating always beats keeping quiet.
  return notificationDigestItemSchema.parse({
    occurredAt: ctx.occurredAt,
    label: clip(rendered.summary, 200),
    detail: rendered.summaryDetail === null ? null : clip(rendered.summaryDetail, 300),
    url: base && rendered.path ? `${base}${rendered.path}` : null,
  });
}

/** Panel screen a digest of this event points to. */
export function notificationDigestPath(key: NotificationEventKey): string | null {
  return CATALOG[key].digestPath;
}
