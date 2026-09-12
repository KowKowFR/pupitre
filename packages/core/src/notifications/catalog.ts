import { z } from 'zod';

/**
 * Catalogue des canaux de notification — la partie *données* de l'abstraction.
 *
 * Même découpage que `Scanner`, `DeploymentDriver` et les fournisseurs d'IA :
 * d'un côté une description déclarative (ici), de l'autre une fabrique qui
 * instancie (`./index.js`). La séparation n'est pas cosmétique — ce module ne
 * dépend que de Zod, ce qui permet au panel Next, aux routes et à `@pupitre/db` de
 * connaître les canaux et leurs champs **sans tirer `nodemailer`** dans leur
 * graphe. C'est la règle déjà appliquée à `ssh2` et au SDK d'IA.
 *
 * Chaque canal décrit lui-même ses champs de configuration : type, obligation,
 * aide, valeur par défaut, **et son schéma Zod**. L'écran se construit à partir
 * de cette liste et les routes valident à partir d'elle. Conséquence recherchée :
 * il n'existe nulle part un `if (kind === 'smtp')` — ni dans l'UI, ni dans les
 * routes, ni en base. Ajouter un cinquième canal, c'est une entrée ici et une
 * classe dans la fabrique.
 */

export const NOTIFICATION_CHANNEL_KINDS = ['smtp', 'telegram', 'discord', 'webhook'] as const;

export const notificationChannelKindSchema = z.enum(NOTIFICATION_CHANNEL_KINDS);
export type NotificationChannelKind = z.infer<typeof notificationChannelKindSchema>;

/**
 * Comment l'écran doit rendre le champ. C'est bien le type du *champ*, pas
 * celui du canal : un `switch` là-dessus dans l'UI est légitime, il y a quatre
 * façons de saisir une valeur et elles ne dépendent d'aucun protocole.
 */
export type NotificationFieldKind = 'text' | 'password' | 'number' | 'boolean' | 'select';

export type NotificationFieldOption = { readonly value: string; readonly label: string };

export type NotificationFieldDescriptor = {
  readonly name: string;
  readonly label: string;
  readonly kind: NotificationFieldKind;
  readonly required: boolean;
  /**
   * Le champ est un secret : chiffré dans sa propre colonne (AES-256-GCM sous
   * `MASTER_KEY`), jamais renvoyé par l'API, jamais journalisé, jamais dans le
   * journal d'audit. Même motif que `targets.encrypted_credential`.
   */
  readonly secret: boolean;
  readonly placeholder: string | null;
  readonly help: string | null;
  readonly options: readonly NotificationFieldOption[] | null;
  readonly defaultValue: string | number | boolean | null;
  /** Validation du champ. La forme du formulaire et celle de la route sortent d'ici. */
  readonly schema: z.ZodTypeAny;
};

export type NotificationChannelDescriptor = {
  readonly kind: NotificationChannelKind;
  readonly label: string;
  readonly description: string;
  /** Ce qu'il faut être allé chercher ailleurs avant de pouvoir configurer le canal. */
  readonly prerequisite: string;
  readonly fields: readonly NotificationFieldDescriptor[];
};

// ─── briques de validation partagées ──────────────────────────────────────────

const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Nom d’hôte ou adresse IP attendu');

/**
 * Une adresse, éventuellement nommée : `a@b.test` ou `Ops <a@b.test>`.
 * Volontairement permissif sur la partie locale — la RFC 5321 l'est aussi, et
 * refuser une adresse valide est plus coûteux ici qu'accepter une adresse fausse,
 * que le serveur SMTP rejettera de toute façon en le disant.
 */
const ADDRESS = /^(?:[^<>@,]{1,80}\s)?<?[^\s<>@,]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}>?$/;

const mailboxSchema = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .refine((value) => ADDRESS.test(value), { message: 'Adresse e-mail invalide' });

const mailboxListSchema = z
  .string()
  .trim()
  .min(3)
  .max(600)
  .refine(
    (value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .every((entry) => ADDRESS.test(entry)),
    { message: 'Liste d’adresses e-mail invalide (séparées par des virgules)' },
  );

/**
 * Une URL http(s), validée par `new URL()` dans un `try`.
 *
 * Le `try` n'est pas décoratif : Zod v4 exécute **tous** les maillons d'une
 * chaîne, y compris après un échec. Un `refine` qui appelle `new URL()` sur une
 * saisie qui n'est pas une URL lève donc une exception que Zod ne rattrape pas
 * — et la route rend 500 au lieu du 422 attendu. Constaté, pas supposé.
 */
const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) => {
      try {
        return /^https?:$/.test(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: 'URL http(s) attendue' },
  );

/** Sépare une liste d'adresses saisie en une seule ligne. */
export function splitMailboxList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function field(
  descriptor: Omit<NotificationFieldDescriptor, 'placeholder' | 'help' | 'options' | 'defaultValue' | 'secret' | 'required'> &
    Partial<Pick<NotificationFieldDescriptor, 'placeholder' | 'help' | 'options' | 'defaultValue' | 'secret' | 'required'>>,
): NotificationFieldDescriptor {
  return {
    placeholder: null,
    help: null,
    options: null,
    defaultValue: null,
    secret: false,
    required: false,
    ...descriptor,
  };
}

// ─── le catalogue ─────────────────────────────────────────────────────────────

const CATALOG = {
  smtp: {
    kind: 'smtp',
    label: 'E-mail (SMTP)',
    description:
      'Envoi par un serveur SMTP, en clair, en STARTTLS ou en SMTPS implicite. ' +
      'Le message part en texte et en HTML : chaque client d’e-mail affiche ce qu’il sait lire.',
    prerequisite:
      'Un serveur SMTP joignable depuis le worker, et une adresse d’expéditeur qu’il accepte.',
    fields: [
      field({
        name: 'host',
        label: 'Serveur',
        kind: 'text',
        required: true,
        placeholder: 'smtp.example.test',
        schema: hostSchema,
      }),
      field({
        name: 'port',
        label: 'Port',
        kind: 'number',
        defaultValue: 587,
        help: '587 pour STARTTLS, 465 pour SMTPS implicite, 25 en interne.',
        schema: z.coerce.number().int().min(1).max(65_535).default(587),
      }),
      field({
        name: 'security',
        label: 'Chiffrement',
        kind: 'select',
        defaultValue: 'starttls',
        options: [
          { value: 'starttls', label: 'STARTTLS (port 587)' },
          { value: 'implicit', label: 'SMTPS implicite (port 465)' },
          { value: 'none', label: 'Aucun — réseau interne uniquement' },
        ],
        help:
          'SMTPS ouvre la session déjà chiffrée ; STARTTLS chiffre après le premier échange. ' +
          '« Aucun » fait voyager l’authentification en clair : à réserver à une liaison locale.',
        schema: z.enum(['starttls', 'implicit', 'none']).default('starttls'),
      }),
      field({
        name: 'user',
        label: 'Identifiant',
        kind: 'text',
        placeholder: 'panel@example.test',
        help: 'Vide si le serveur n’exige pas d’authentification (relais interne).',
        schema: z.string().trim().max(200),
      }),
      field({
        name: 'password',
        label: 'Mot de passe',
        kind: 'password',
        secret: true,
        help: 'Chiffré en base. Il ne ressort jamais — ni par l’API, ni dans les journaux.',
        schema: z.string().min(1).max(400),
      }),
      field({
        name: 'from',
        label: 'Expéditeur',
        kind: 'text',
        required: true,
        placeholder: 'Control plane <panel@example.test>',
        schema: mailboxSchema,
      }),
      field({
        name: 'to',
        label: 'Destinataires',
        kind: 'text',
        required: true,
        placeholder: 'ops@example.test, astreinte@example.test',
        help: 'Séparés par des virgules.',
        schema: mailboxListSchema,
      }),
      field({
        name: 'rejectUnauthorized',
        label: 'Vérifier le certificat TLS',
        kind: 'boolean',
        defaultValue: true,
        help:
          'À décocher seulement pour un serveur interne à certificat auto-signé. ' +
          'Décocher expose la session à une interception.',
        schema: z.boolean().default(true),
      }),
    ],
  },
  telegram: {
    kind: 'telegram',
    label: 'Telegram',
    description:
      'Message envoyé par un bot dans une conversation ou un groupe. Rendu en MarkdownV2, ' +
      'échappements compris.',
    prerequisite:
      'Un bot créé auprès de @BotFather (jeton), et l’identifiant de la conversation — ' +
      'le bot doit y avoir été ajouté au moins une fois.',
    fields: [
      field({
        name: 'botToken',
        label: 'Jeton du bot',
        kind: 'password',
        required: true,
        secret: true,
        placeholder: '123456789:AA…',
        help: 'Donné par @BotFather. Chiffré en base, jamais renvoyé.',
        schema: z.string().trim().min(10).max(200),
      }),
      field({
        name: 'chatId',
        label: 'Identifiant de conversation',
        kind: 'text',
        required: true,
        placeholder: '-1001234567890',
        help: 'Négatif pour un groupe ou un canal, positif pour une conversation directe.',
        schema: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .regex(/^(-?\d+|@[A-Za-z0-9_]{3,})$/, 'Identifiant numérique ou @nom_public attendu'),
      }),
      field({
        name: 'apiBaseUrl',
        label: 'API Bot (avancé)',
        kind: 'text',
        placeholder: 'https://api.telegram.org',
        help:
          'Vide = l’API publique. À renseigner seulement si vous hébergez votre propre ' +
          'serveur Bot API (telegram-bot-api), ou pour une vérification hors ligne.',
        schema: httpUrlSchema,
      }),
    ],
  },
  discord: {
    kind: 'discord',
    label: 'Discord',
    description:
      'Message déposé par un webhook de salon, rendu en `embed` coloré selon la gravité.',
    prerequisite:
      'Un webhook créé dans les paramètres du salon Discord (Intégrations → Webhooks). ' +
      'Son URL contient un jeton : c’est un secret.',
    fields: [
      field({
        name: 'webhookUrl',
        label: 'URL du webhook',
        kind: 'password',
        required: true,
        secret: true,
        placeholder: 'https://discord.com/api/webhooks/…',
        help:
          'Cette URL vaut mot de passe : quiconque la détient peut écrire dans le salon. ' +
          'Chiffrée en base, jamais renvoyée.',
        schema: httpUrlSchema.refine(
          (value) => {
            try {
              return new URL(value).pathname.includes('/api/webhooks/');
            } catch {
              return false;
            }
          },
          { message: 'URL de webhook Discord attendue (…/api/webhooks/…)' },
        ),
      }),
      field({
        name: 'username',
        label: 'Nom affiché',
        kind: 'text',
        placeholder: 'Control plane',
        help: 'Vide = le nom configuré sur le webhook côté Discord.',
        schema: z.string().trim().max(80),
      }),
    ],
  },
  webhook: {
    kind: 'webhook',
    label: 'Webhook (JSON)',
    description:
      'POST du message neutre, en JSON brut, sans mise en forme. Pour brancher un système ' +
      'maison, une passerelle d’astreinte ou un agrégateur.',
    prerequisite: 'Une URL qui accepte un POST JSON et répond 2xx.',
    fields: [
      field({
        name: 'url',
        label: 'URL',
        kind: 'text',
        required: true,
        placeholder: 'https://hooks.example.test/control-plane',
        schema: httpUrlSchema,
      }),
      field({
        name: 'token',
        label: 'Jeton',
        kind: 'password',
        secret: true,
        help: 'Envoyé en en-tête « Authorization: Bearer … ». Chiffré en base.',
        schema: z.string().trim().min(1).max(400),
      }),
    ],
  },
} as const satisfies Record<NotificationChannelKind, NotificationChannelDescriptor>;

export function notificationChannelDescriptor(
  kind: NotificationChannelKind,
): NotificationChannelDescriptor {
  return CATALOG[kind];
}

export function notificationChannelDescriptors(): NotificationChannelDescriptor[] {
  return NOTIFICATION_CHANNEL_KINDS.map((kind) => CATALOG[kind]);
}

export function isNotificationChannelKind(value: unknown): value is NotificationChannelKind {
  return typeof value === 'string' && Object.hasOwn(CATALOG, value);
}

// ─── configuration d'un canal ─────────────────────────────────────────────────

/** Valeurs de configuration d'un canal. Plates, à dessein : rien à imbriquer ici. */
export type ChannelConfig = Record<string, string | number | boolean>;

function shapeOf(fields: readonly NotificationFieldDescriptor[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const entry of fields) {
    shape[entry.name] = entry.required ? entry.schema : entry.schema.optional();
  }
  // `strip` : un champ inconnu est retiré, pas refusé. Le formulaire d'un canal
  // peut envoyer les champs d'un autre en cours de changement de type.
  return z.object(shape);
}

/** Champs **non secrets**. Stockés en clair dans `notification_channels.config`. */
export function channelConfigSchema(kind: NotificationChannelKind): z.ZodTypeAny {
  return shapeOf(CATALOG[kind].fields.filter((entry) => !entry.secret));
}

/** Champs **secrets**. Chiffrés en bloc dans `notification_channels.encrypted_secrets`. */
export function channelSecretsSchema(kind: NotificationChannelKind): z.ZodTypeAny {
  return shapeOf(CATALOG[kind].fields.filter((entry) => entry.secret));
}

/** Noms des champs secrets d'un canal — sert à dire *lesquels* sont renseignés. */
export function channelSecretFields(kind: NotificationChannelKind): string[] {
  return CATALOG[kind].fields.filter((entry) => entry.secret).map((entry) => entry.name);
}

// ─── présentation ─────────────────────────────────────────────────────────────

/**
 * Le catalogue débarrassé de ses schémas Zod, donc sérialisable en JSON.
 *
 * L'écran se construit à partir de cette forme : il n'écrit le nom d'aucun
 * canal ni d'aucun champ. Une `RegExp` ou une fonction ne traversent pas
 * `JSON.stringify` — les laisser passer donnerait un `{}` silencieux côté
 * client, et un formulaire vide sans erreur.
 */
export type PresentedNotificationField = Omit<NotificationFieldDescriptor, 'schema'>;

export type PresentedNotificationChannel = Omit<NotificationChannelDescriptor, 'fields'> & {
  fields: PresentedNotificationField[];
};

export function presentNotificationChannels(): PresentedNotificationChannel[] {
  return notificationChannelDescriptors().map((descriptor) => ({
    kind: descriptor.kind,
    label: descriptor.label,
    description: descriptor.description,
    prerequisite: descriptor.prerequisite,
    fields: descriptor.fields.map(({ schema: _schema, ...rest }) => ({ ...rest })),
  }));
}
