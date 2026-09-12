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
 *   monitor.down              un site supervisé est tombé, panne confirmée
 *   monitor.recovered         ce site est revenu
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
  'monitor.down',
  'monitor.recovered',
  'target.threshold.breached',
  'target.threshold.cleared',
] as const;

export type NotificationEventKey = (typeof NOTIFICATION_EVENT_KEYS)[number];

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

export type NotificationEventDescriptor = {
  readonly key: NotificationEventKey;
  readonly label: string;
  readonly description: string;
  /** Pourquoi celui-ci mérite un message alors que le journal d'audit existe déjà. */
  readonly rationale: string;
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
  return ['Déclenché par', ctx.actor ?? 'le système (tâche planifiée ou worker)'];
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
 * Le verdict d'une sonde, en français. Il vit ici et non dans un `switch` chez
 * l'appelant : c'est de la mise en forme de message, et `message.ts` interdit
 * qu'elle fuie ailleurs.
 */
function monitorVerdict(status: unknown): string {
  switch (text(status, '')) {
    case 'unreachable':
      return 'injoignable';
    case 'unhealthy':
      return 'répond mal';
    case 'healthy':
      return 'sain';
    default:
      return 'état inconnu';
  }
}

/**
 * Le même verdict, mais en prédicat.
 *
 * Deux fonctions et non une, parce que le français ne se laisse pas
 * concaténer : « est injoignable » se dit avec le verbe être, « répond mal »
 * porte le sien. Coller un `est ${verdict}` devant l'adjectif donnait « est
 * répond mal ». Constaté à la première exécution, pas supposé.
 */
function monitorVerdictSentence(status: unknown): string {
  switch (text(status, '')) {
    case 'unreachable':
      return 'est injoignable';
    case 'unhealthy':
      return 'répond mal';
    case 'healthy':
      return 'répond normalement';
    default:
      return 'est dans un état inconnu';
  }
}

/** « 4 min », « 1 h 20 », « 2 j ». `null` quand la durée n'est pas connue. */
function monitorDuration(seconds: unknown): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} h` : `${hours} h ${rest}`;
  return `${Math.floor(hours / 24)} j`;
}

/**
 * Ce qui identifie la sonde dans une ligne de résumé.
 *
 * Le nom **et** la cible, parce que ce ne sont pas les mêmes informations :
 * l'opérateur a nommé la sonde (« boutique »), mais c'est l'URL qui dit
 * laquelle des trois boutiques est tombée. Un résumé de douze pannes doit
 * pouvoir se lire sans ouvrir le panel.
 */
function monitorLabel(entry: NotifiableAuditEntry): string {
  const after = record(entry.after);
  const name = text(after.name, entry.resourceId ?? '?');
  const target = optional(after.target);
  return clip(target === null || target === name ? `site ${name}` : `site ${name} — ${target}`, 200);
}

const CATALOG = {
  'deployment.failed': {
    key: 'deployment.failed',
    label: 'Déploiement en échec',
    description: 'Une mise en ligne s’est arrêtée sur une étape en erreur.',
    rationale:
      'L’application visée n’est pas à jour, et personne ne le sait tant que quelqu’un ' +
      'n’ouvre pas l’écran des déploiements.',
    severity: 'critical',
    auditAction: 'deployment.failed',
    digestPath: '/deployments',
    matches: (entry) => text(record(entry.after).failedStep, '') !== 'scan',
    render: (entry, ctx) => {
      const after = record(entry.after);
      return {
        title: 'Déploiement en échec',
        body:
          `Le déploiement ${entry.resourceId ?? ''} s’est arrêté` +
          `${optional(after.failedStep) ? ` sur l’étape « ${text(after.failedStep, '')} »` : ''}. ` +
          'La version précédente, si elle tournait, tourne toujours.',
        fields: fieldsOf([
          ['Déploiement', entry.resourceId],
          ['Étape', optional(after.failedStep)],
          ['Erreur', optional(after.error)],
          actorField(ctx),
        ]),
        path: entry.resourceId ? `/deployments/${entry.resourceId}` : null,
        summary: `déploiement ${entry.resourceId ?? '?'}`,
        summaryDetail: optional(after.failedStep)
          ? `étape « ${text(after.failedStep, '')} »`
          : optional(after.error),
      };
    },
  },
  'deployment.scan_blocked': {
    key: 'deployment.scan_blocked',
    label: 'Mise en ligne bloquée par un scan',
    description:
      'L’analyse de sécurité a trouvé une vulnérabilité au-delà du seuil et a empêché la mise en ligne.',
    rationale:
      'C’est le seul cas où le panel refuse volontairement de faire ce qu’on lui demande. ' +
      'Sans message, l’opérateur croit à une panne et relance en boucle.',
    severity: 'critical',
    auditAction: 'deployment.failed',
    digestPath: '/deployments',
    matches: (entry) => text(record(entry.after).failedStep, '') === 'scan',
    render: (entry, ctx) => {
      const after = record(entry.after);
      return {
        title: 'Mise en ligne bloquée par l’analyse de sécurité',
        body:
          `Le déploiement ${entry.resourceId ?? ''} a été arrêté à l’étape d’analyse : une ` +
          'vulnérabilité atteint le seuil de blocage configuré pour l’instance. Rien n’a été ' +
          'mis en ligne.',
        fields: fieldsOf([
          ['Déploiement', entry.resourceId],
          ['Verdict', optional(after.error)],
          actorField(ctx),
        ]),
        path: entry.resourceId ? `/deployments/${entry.resourceId}` : null,
        summary: `déploiement ${entry.resourceId ?? '?'}`,
        summaryDetail: optional(after.error),
      };
    },
  },
  'deployment.rolled_back': {
    key: 'deployment.rolled_back',
    label: 'Retour arrière automatique',
    description: 'Le healthcheck a échoué et le panel est revenu seul à la version précédente.',
    rationale:
      'L’état de production a changé sans que personne ne l’ait demandé. C’est exactement ' +
      'le genre de chose qu’on ne veut pas découvrir trois jours plus tard.',
    severity: 'warning',
    auditAction: 'deployment.rolled_back.automatic',
    digestPath: '/deployments',
    matches: () => true,
    render: (entry, ctx) => {
      const after = record(entry.after);
      const before = record(entry.before);
      return {
        title: 'Retour arrière automatique',
        body:
          `La version ${text(before.version, '?')} n’a pas répondu au healthcheck. Le panel est ` +
          `revenu seul à la version ${text(after.restoredVersion, '?')}, qui répond. ` +
          'La mise en ligne est à reprendre.',
        fields: fieldsOf([
          ['Déploiement', entry.resourceId],
          ['Version tentée', optional(before.version)],
          ['Version restaurée', optional(after.restoredVersion)],
          ['Raison', optional(after.reason)],
          ['URL', optional(after.url)],
          actorField(ctx),
        ]),
        path: entry.resourceId ? `/deployments/${entry.resourceId}` : null,
        summary: `déploiement ${entry.resourceId ?? '?'}`,
        summaryDetail: `${text(before.version, '?')} → ${text(after.restoredVersion, '?')}`,
      };
    },
  },
  'security.two_factor_reset': {
    key: 'security.two_factor_reset',
    label: 'Second facteur réinitialisé',
    description: 'Un administrateur a levé le second facteur d’un compte.',
    rationale:
      'C’est le geste qui rouvre un compte protégé. Il est légitime la plupart du temps — ' +
      'et c’est précisément pour ça qu’il doit être vu par quelqu’un d’autre que celui qui le fait.',
    severity: 'warning',
    auditAction: 'user.2fa.reset',
    digestPath: '/admin/users',
    matches: () => true,
    render: (entry, ctx) => {
      const after = record(entry.after);
      return {
        title: 'Second facteur réinitialisé',
        body:
          `Le second facteur du compte ${text(after.email, entry.resourceId ?? '?')} a été levé. ` +
          'Ses sessions ouvertes ont été fermées, ses appareils de confiance oubliés.',
        fields: fieldsOf([
          ['Compte', text(after.email, entry.resourceId ?? '?')],
          ['Réinitialisation par soi-même', after.self === true ? 'oui' : 'non'],
          ['Sessions fermées', optional(after.revokedSessions)],
          actorField(ctx),
        ]),
        path: '/admin/users',
        summary: `compte ${text(after.email, entry.resourceId ?? '?')}`,
        summaryDetail: after.self === true ? 'par lui-même' : (ctx.actor ?? 'par le système'),
      };
    },
  },
  'security.role_changed': {
    key: 'security.role_changed',
    label: 'Rôle d’un utilisateur modifié',
    description: 'Un compte a changé de rôle, donc de permissions.',
    rationale:
      'Une élévation de droits est la porte d’entrée de tout le reste. Elle doit être ' +
      'visible immédiatement, pas au prochain audit trimestriel.',
    severity: 'warning',
    auditAction: 'user.role.changed',
    digestPath: '/admin/users',
    matches: () => true,
    render: (entry, ctx) => {
      const after = record(entry.after);
      const before = record(entry.before);
      return {
        title: 'Rôle d’un utilisateur modifié',
        body:
          `Le compte ${text(after.email, entry.resourceId ?? '?')} passe de ` +
          `« ${text(before.roles, 'aucun rôle')} » à « ${text(after.roles, '?')} ».`,
        fields: fieldsOf([
          ['Compte', text(after.email, entry.resourceId ?? '?')],
          ['Avant', optional(before.roles) ?? 'aucun rôle'],
          ['Après', optional(after.roles)],
          actorField(ctx),
        ]),
        path: '/admin/users',
        summary: `compte ${text(after.email, entry.resourceId ?? '?')}`,
        summaryDetail: `${optional(before.roles) ?? 'aucun rôle'} → ${text(after.roles, '?')}`,
      };
    },
  },
  'monitor.down': {
    key: 'monitor.down',
    label: 'Site en panne',
    description:
      'Une sonde a confirmé qu’un site ne répond plus comme attendu, après son seuil d’échecs consécutifs.',
    rationale:
      'C’est le seul événement du catalogue qui parle de ce qui est **déjà en ligne**, et non ' +
      'de ce qu’on essaie d’y mettre. Un site tombé ne produit aucune autre trace : personne ' +
      'ne rafraîchit l’écran des sondes à trois heures du matin.',
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
      const verdict = monitorVerdict(after.status);
      const failures = optional(after.consecutiveFailures);
      const target = text(after.target, '?');

      return {
        title: `Site en panne — ${text(after.name, entry.resourceId ?? '?')}`,
        body:
          `La sonde « ${text(after.name, '?')} » sur ${target} ${monitorVerdictSentence(after.status)}` +
          `${optional(after.detail) ? ` : ${text(after.detail, '')}` : ''}. ` +
          `La panne est confirmée${failures ? ` après ${failures} échecs consécutifs` : ''} — ` +
          'ce n’est pas un rebond isolé.',
        fields: fieldsOf([
          ['Sonde', optional(after.name)],
          ['Cible', optional(after.target)],
          ['Verdict', verdict],
          ['Constat', optional(after.detail)],
          ['Échecs consécutifs', failures],
          ['Incident', optional(after.incidentId)],
          actorField(ctx),
        ]),
        path: entry.resourceId ? `/monitors/${entry.resourceId}` : null,
        summary: monitorLabel(entry),
        // La nature de la panne, pas la catégorie : c'est elle qui distingue
        // « le serveur rend 503 » de « plus rien n'écoute sur le port ».
        summaryDetail: clip(
          `${verdict}${optional(after.detail) ? ` — ${text(after.detail, '')}` : ''}`,
          300,
        ),
      };
    },
  },
  'monitor.recovered': {
    key: 'monitor.recovered',
    label: 'Site rétabli',
    description: 'Une sonde en panne est repassée au vert, après son seuil de succès consécutifs.',
    rationale:
      'Seul « succès » du catalogue, et c’est assumé : il ne s’adresse qu’à quelqu’un qui a ' +
      'déjà reçu la panne. Une alerte sans son pendant oblige à aller vérifier à la main, ' +
      'c’est-à-dire exactement ce qu’on voulait éviter en installant des sondes.',
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
      const duration = monitorDuration(after.durationSeconds);
      const target = text(after.target, '?');

      return {
        title: `Site rétabli — ${text(after.name, entry.resourceId ?? '?')}`,
        body:
          `La sonde « ${text(after.name, '?')} » sur ${target} répond de nouveau normalement. ` +
          `L’incident est refermé${duration ? ` après ${duration} de panne` : ''}. ` +
          'Aucune action n’est attendue.',
        fields: fieldsOf([
          ['Sonde', optional(after.name)],
          ['Cible', optional(after.target)],
          ['Était', monitorVerdict(before.status)],
          ['Durée de la panne', duration],
          ['Incident', optional(after.incidentId)],
          actorField(ctx),
        ]),
        path: entry.resourceId ? `/monitors/${entry.resourceId}` : null,
        summary: monitorLabel(entry),
        summaryDetail: duration ? `rétabli après ${duration} de panne` : 'rétabli',
      };
    },
  },
  'target.threshold.breached': {
    key: 'target.threshold.breached',
    label: 'Seuil de machine franchi',
    description:
      'Une machine cible a dépassé un seuil de charge, de mémoire ou de disque, confirmé sur ' +
      'plusieurs relevés consécutifs.',
    rationale:
      'Un disque qui se remplit ne casse rien jusqu’au moment où il casse tout, et il ne casse ' +
      'pas seulement l’application qu’on regarde : il casse toutes celles que la machine porte. ' +
      'C’est le seul événement du catalogue qui prévient **avant** la panne plutôt qu’après.',
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
      const machine = text(after.targetName, '?');
      const constat = text(after.detail, 'seuil dépassé');
      const limite = optional(after.limitPercent);
      const releves = optional(after.samples);

      return {
        title: `Seuil franchi — ${machine}`,
        summary: `machine ${machine} — ${constat}`,
        summaryDetail: limite === null ? constat : `${constat} (seuil ${limite} %)`,
        body:
          `La machine « ${machine} » a franchi un seuil de supervision : ${constat}. ` +
          (limite === null ? '' : `Le seuil est fixé à ${limite} %. `) +
          (releves === null
            ? ''
            : `Le dépassement est confirmé sur ${releves} relevé(s) consécutif(s) — ce n’est pas un pic isolé. `) +
          'Les applications déployées sur cette machine sont exposées, pas seulement celle qu’on surveille.',
        fields: fieldsOf([
          ['Machine', machine],
          ['Métrique', optional(after.metricLabel)],
          ['Constat', constat],
          ['Seuil', limite === null ? null : `${limite} %`],
          ['Relevés consécutifs', releves],
          ['Origine du seuil', optional(after.thresholdOrigin)],
          actorField(ctx),
        ]),
        path: '/apps',
      };
    },
  },
  'target.threshold.cleared': {
    key: 'target.threshold.cleared',
    label: 'Seuil de machine rétabli',
    description: 'Une machine cible est repassée sous un seuil qu’elle avait franchi.',
    rationale:
      'Le pendant du précédent, et pour la même raison qu’un site rétabli : sans lui, personne ' +
      'ne sait si l’alerte de la nuit est toujours d’actualité au matin.',
    severity: 'info',
    auditAction: 'target.threshold.cleared',
    digestPath: '/apps',
    matches: () => true,
    dedupDiscriminator: (entry) => optional(record(entry.after).breachId),
    render: (entry, ctx) => {
      const after = record(entry.after);
      const machine = text(after.targetName, '?');
      const metrique = text(after.metricLabel, 'seuil');
      const duree = optional(after.durationSeconds);
      // `threshold_disabled` : l'épisode s'est refermé parce qu'on a coupé le
      // seuil, pas parce que la machine va mieux. Le taire serait un faux
      // soulagement — c'est exactement le genre de message qu'on lit vite.
      const coupe = text(after.reason, 'crossed') === 'threshold_disabled';

      return {
        title: `Seuil rétabli — ${machine}`,
        summary: `machine ${machine} — ${metrique.toLowerCase()} sous le seuil`,
        summaryDetail: coupe
          ? 'le seuil a été désactivé, la machine n’a pas forcément changé'
          : `${text(after.detail, 'sous le seuil')}`,
        body: coupe
          ? `L’alerte sur « ${machine} » (${metrique.toLowerCase()}) est levée parce que le seuil ` +
            'a été désactivé, **pas** parce que la machine est repassée en dessous. Rien n’indique ' +
            'que la situation se soit améliorée.'
          : `La machine « ${machine} » est repassée sous son seuil de ${metrique.toLowerCase()}. ` +
            (duree === null ? '' : `Le dépassement aura duré ${monitorDuration(duree)}.`),
        fields: fieldsOf([
          ['Machine', machine],
          ['Métrique', optional(after.metricLabel)],
          ['Pire valeur atteinte', optional(after.peakValue)],
          ['Durée du dépassement', duree === null ? null : monitorDuration(duree)],
          ['Levée par', coupe ? 'désactivation du seuil' : 'retour sous le seuil'],
          actorField(ctx),
        ]),
        path: '/apps',
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

/** Le catalogue sans ses fonctions, donc sérialisable vers l'écran. */
export type PresentedNotificationEvent = Pick<
  NotificationEventDescriptor,
  'key' | 'label' | 'description' | 'rationale' | 'severity'
>;

export function presentNotificationEvents(): PresentedNotificationEvent[] {
  return notificationEventDescriptors().map(({ key, label, description, rationale, severity }) => ({
    key,
    label,
    description,
    rationale,
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
