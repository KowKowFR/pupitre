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
 * fonctionnalité — c'est-à-dire de ne plus être prévenu de *rien*. Cinq
 * événements sont retenus, tous répondant à la même question : « faut-il que
 * quelqu'un se lève ? »
 *
 *   deployment.failed         une mise en ligne n'a pas abouti
 *   deployment.scan_blocked   une image vulnérable a été arrêtée avant la mise en ligne
 *   deployment.rolled_back    le panel est revenu tout seul à la version d'avant
 *   security.two_factor_reset une protection de compte a été levée
 *   security.role_changed     quelqu'un a gagné ou perdu des droits
 *
 * Sont écartés, volontairement : les succès (un déploiement qui marche ne
 * réveille personne), les refus de permission (bavards et déjà tracés), les
 * relevés périodiques, et tout ce que la supervision de sites couvre déjà de
 * son côté.
 *
 * ── Pourquoi la source est le journal d'audit ───────────────────────────────
 * Ces cinq événements passent **déjà** par `logAudit()`, le point d'entrée
 * unique de la traçabilité. Les redécrire à la main sur chaque site d'émission
 * demanderait de modifier le pipeline de déploiement, deux routes
 * d'administration et le worker — et de recommencer au prochain événement. En
 * dérivant d'une entrée d'audit, la correspondance « ce qui s'est passé » →
 * « ce qu'on envoie » tient dans cette seule table, et rien en amont ne bouge.
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
   * Départage deux événements portés par la même action d'audit. Un scan qui
   * bloque et un déploiement qui casse s'écrivent tous deux `deployment.failed` :
   * seul `failedStep` les distingue.
   */
  readonly matches: (entry: NotifiableAuditEntry) => boolean;
  readonly render: (entry: NotifiableAuditEntry, ctx: NotificationRenderContext) => RenderedEvent;
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
