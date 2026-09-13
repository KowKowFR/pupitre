import {
  DEFAULT_UI_LANGUAGE,
  renderMessage,
  type Translated,
  type UiLanguage,
} from '../i18n.js';
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

/**
 * Un champ, réduit à sa **structure**. Ses textes — libellé, aide, libellés
 * d'options — vivent dans le dictionnaire plus bas, sous des clés dérivées du
 * canal et du nom du champ. Un descripteur n'a donc pas de langue, et
 * `presentNotificationChannels()` est le seul endroit qui en demande une.
 *
 * Le `placeholder` reste ici, et c'est délibéré : `smtp.example.test` ou
 * `ops@example.test` sont des exemples de valeur, pas des phrases. Les
 * traduire n'aurait rien produit de différent.
 */
export type NotificationFieldDescriptor = {
  readonly name: string;
  readonly kind: NotificationFieldKind;
  readonly required: boolean;
  /**
   * Le champ est un secret : chiffré dans sa propre colonne (AES-256-GCM sous
   * `MASTER_KEY`), jamais renvoyé par l'API, jamais journalisé, jamais dans le
   * journal d'audit. Même motif que `targets.encrypted_credential`.
   */
  readonly secret: boolean;
  readonly placeholder: string | null;
  /** Valeurs acceptées d'un `select`. Ce sont des clés : elles ne se traduisent pas. */
  readonly options: readonly string[] | null;
  readonly defaultValue: string | number | boolean | null;
  /** Validation du champ. La forme du formulaire et celle de la route sortent d'ici. */
  readonly schema: z.ZodTypeAny;
};

export type NotificationChannelDescriptor = {
  readonly kind: NotificationChannelKind;
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
  descriptor: Omit<NotificationFieldDescriptor, 'placeholder' | 'options' | 'defaultValue' | 'secret' | 'required'> &
    Partial<Pick<NotificationFieldDescriptor, 'placeholder' | 'options' | 'defaultValue' | 'secret' | 'required'>>,
): NotificationFieldDescriptor {
  return {
    placeholder: null,
    options: null,
    defaultValue: null,
    secret: false,
    required: false,
    ...descriptor,
  };
}

// ─── les mots du catalogue ────────────────────────────────────────────────────

/**
 * Ce que l'écran de configuration affiche d'un canal : son nom, ce qu'il fait,
 * ce qu'il faut être allé chercher avant, puis le libellé et l'aide de chaque
 * champ. Les clés sont dérivées du canal et du nom du champ — même convention
 * que celle des chemins de configuration.
 *
 * Ne s'y trouvent pas, et volontairement : les valeurs d'option (`starttls`,
 * `implicit`), les noms de protocole et de service (Telegram, Discord,
 * @BotFather), les exemples de saisie, et les messages Zod — ces derniers
 * voyagent dans `details`, que le panel n'affiche pas.
 */
const fr = {
  'smtp.label': 'E-mail (SMTP)',
  'smtp.description':
    'Envoi par un serveur SMTP, en clair, en STARTTLS ou en SMTPS implicite. ' +
    'Le message part en texte et en HTML : chaque client d’e-mail affiche ce qu’il sait lire.',
  'smtp.prerequisite':
    'Un serveur SMTP joignable depuis le worker, et une adresse d’expéditeur qu’il accepte.',
  'smtp.host.label': 'Serveur',
  'smtp.port.label': 'Port',
  'smtp.port.help': '587 pour STARTTLS, 465 pour SMTPS implicite, 25 en interne.',
  'smtp.security.label': 'Chiffrement',
  'smtp.security.option.starttls': 'STARTTLS (port 587)',
  'smtp.security.option.implicit': 'SMTPS implicite (port 465)',
  'smtp.security.option.none': 'Aucun — réseau interne uniquement',
  'smtp.security.help':
    'SMTPS ouvre la session déjà chiffrée ; STARTTLS chiffre après le premier échange. ' +
    '« Aucun » fait voyager l’authentification en clair : à réserver à une liaison locale.',
  'smtp.user.label': 'Identifiant',
  'smtp.user.help': 'Vide si le serveur n’exige pas d’authentification (relais interne).',
  'smtp.password.label': 'Mot de passe',
  'smtp.password.help':
    'Chiffré en base. Il ne ressort jamais — ni par l’API, ni dans les journaux.',
  'smtp.from.label': 'Expéditeur',
  'smtp.to.label': 'Destinataires',
  'smtp.to.help': 'Séparés par des virgules.',
  'smtp.rejectUnauthorized.label': 'Vérifier le certificat TLS',
  'smtp.rejectUnauthorized.help':
    'À décocher seulement pour un serveur interne à certificat auto-signé. ' +
    'Décocher expose la session à une interception.',

  'telegram.label': 'Telegram',
  'telegram.description':
    'Message envoyé par un bot dans une conversation ou un groupe. Rendu en MarkdownV2, ' +
    'échappements compris.',
  'telegram.prerequisite':
    'Un bot créé auprès de @BotFather (jeton), et l’identifiant de la conversation — ' +
    'le bot doit y avoir été ajouté au moins une fois.',
  'telegram.botToken.label': 'Jeton du bot',
  'telegram.botToken.help': 'Donné par @BotFather. Chiffré en base, jamais renvoyé.',
  'telegram.chatId.label': 'Identifiant de conversation',
  'telegram.chatId.help':
    'Négatif pour un groupe ou un canal, positif pour une conversation directe.',
  'telegram.apiBaseUrl.label': 'API Bot (avancé)',
  'telegram.apiBaseUrl.help':
    'Vide = l’API publique. À renseigner seulement si vous hébergez votre propre ' +
    'serveur Bot API (telegram-bot-api), ou pour une vérification hors ligne.',

  'discord.label': 'Discord',
  'discord.description':
    'Message déposé par un webhook de salon, rendu en `embed` coloré selon la gravité.',
  'discord.prerequisite':
    'Un webhook créé dans les paramètres du salon Discord (Intégrations → Webhooks). ' +
    'Son URL contient un jeton : c’est un secret.',
  'discord.webhookUrl.label': 'URL du webhook',
  'discord.webhookUrl.help':
    'Cette URL vaut mot de passe : quiconque la détient peut écrire dans le salon. ' +
    'Chiffrée en base, jamais renvoyée.',
  'discord.username.label': 'Nom affiché',
  'discord.username.help': 'Vide = le nom configuré sur le webhook côté Discord.',

  'webhook.label': 'Webhook (JSON)',
  'webhook.description':
    'POST du message neutre, en JSON brut, sans mise en forme. Pour brancher un système ' +
    'maison, une passerelle d’astreinte ou un agrégateur.',
  'webhook.prerequisite': 'Une URL qui accepte un POST JSON et répond 2xx.',
  'webhook.url.label': 'URL',
  'webhook.token.label': 'Jeton',
  'webhook.token.help': 'Envoyé en en-tête « Authorization: Bearer … ». Chiffré en base.',
} as const;

const en: Translated<typeof fr> = {
  'smtp.label': 'Email (SMTP)',
  'smtp.description':
    'Sent through an SMTP server, in the clear, over STARTTLS or over implicit SMTPS. ' +
    'The message goes out as text and as HTML: every mail client shows what it can read.',
  'smtp.prerequisite': 'An SMTP server the worker can reach, and a sender address it accepts.',
  'smtp.host.label': 'Server',
  'smtp.port.label': 'Port',
  'smtp.port.help': '587 for STARTTLS, 465 for implicit SMTPS, 25 on an internal relay.',
  'smtp.security.label': 'Encryption',
  'smtp.security.option.starttls': 'STARTTLS (port 587)',
  'smtp.security.option.implicit': 'Implicit SMTPS (port 465)',
  'smtp.security.option.none': 'None — internal network only',
  'smtp.security.help':
    'SMTPS opens the session already encrypted; STARTTLS encrypts after the first exchange. ' +
    '“None” sends the credentials in the clear: keep it for a local link.',
  'smtp.user.label': 'Username',
  'smtp.user.help': 'Leave empty if the server requires no authentication (internal relay).',
  'smtp.password.label': 'Password',
  'smtp.password.help':
    'Encrypted at rest. It never comes back out — not through the API, not in the logs.',
  'smtp.from.label': 'Sender',
  'smtp.to.label': 'Recipients',
  'smtp.to.help': 'Comma-separated.',
  'smtp.rejectUnauthorized.label': 'Verify the TLS certificate',
  'smtp.rejectUnauthorized.help':
    'Uncheck only for an internal server with a self-signed certificate. ' +
    'Unchecking leaves the session open to interception.',

  'telegram.label': 'Telegram',
  'telegram.description':
    'Message sent by a bot into a chat or a group. Rendered in MarkdownV2, escaping included.',
  'telegram.prerequisite':
    'A bot created with @BotFather (token), and the chat ID — the bot has to have been added ' +
    'to that chat at least once.',
  'telegram.botToken.label': 'Bot token',
  'telegram.botToken.help': 'Given by @BotFather. Encrypted at rest, never returned.',
  'telegram.chatId.label': 'Chat ID',
  'telegram.chatId.help': 'Negative for a group or a channel, positive for a direct chat.',
  'telegram.apiBaseUrl.label': 'Bot API (advanced)',
  'telegram.apiBaseUrl.help':
    'Empty = the public API. Fill it in only if you host your own Bot API server ' +
    '(telegram-bot-api), or to check offline.',

  'discord.label': 'Discord',
  'discord.description':
    'Message dropped by a channel webhook, rendered as an `embed` colored by severity.',
  'discord.prerequisite':
    'A webhook created in the Discord channel settings (Integrations → Webhooks). ' +
    'Its URL carries a token: it is a secret.',
  'discord.webhookUrl.label': 'Webhook URL',
  'discord.webhookUrl.help':
    'This URL is a password: whoever holds it can write in the channel. ' +
    'Encrypted at rest, never returned.',
  'discord.username.label': 'Display name',
  'discord.username.help': 'Empty = the name set on the webhook in Discord.',

  'webhook.label': 'Webhook (JSON)',
  'webhook.description':
    'POSTs the neutral message as raw JSON, unformatted. To plug in a homegrown system, ' +
    'an on-call gateway or an aggregator.',
  'webhook.prerequisite': 'A URL that accepts a JSON POST and answers 2xx.',
  'webhook.url.label': 'URL',
  'webhook.token.label': 'Token',
  'webhook.token.help': 'Sent as an “Authorization: Bearer …” header. Encrypted at rest.',
};

const CATALOG_TEXT = { fr, en };

function t(language: UiLanguage, key: keyof typeof fr): string {
  return renderMessage(CATALOG_TEXT, language, key);
}

/**
 * Le texte d'une clé composée, ou `null` s'il n'y en a pas.
 *
 * Les clés se construisent à partir du canal et du nom du champ : le
 * compilateur ne peut donc pas savoir lequel porte une aide. L'absence est une
 * réponse valide — un champ sans aide n'en affiche pas.
 */
function optionalText(language: UiLanguage, key: string): string | null {
  return Object.hasOwn(fr, key) ? t(language, key as keyof typeof fr) : null;
}

// ─── le catalogue ─────────────────────────────────────────────────────────────

const CATALOG = {
  smtp: {
    kind: 'smtp',
    fields: [
      field({
        name: 'host',
        kind: 'text',
        required: true,
        placeholder: 'smtp.example.test',
        schema: hostSchema,
      }),
      field({
        name: 'port',
        kind: 'number',
        defaultValue: 587,
        schema: z.coerce.number().int().min(1).max(65_535).default(587),
      }),
      field({
        name: 'security',
        kind: 'select',
        defaultValue: 'starttls',
        options: ['starttls', 'implicit', 'none'],
        schema: z.enum(['starttls', 'implicit', 'none']).default('starttls'),
      }),
      field({
        name: 'user',
        kind: 'text',
        placeholder: 'panel@example.test',
        schema: z.string().trim().max(200),
      }),
      field({
        name: 'password',
        kind: 'password',
        secret: true,
        schema: z.string().min(1).max(400),
      }),
      field({
        name: 'from',
        kind: 'text',
        required: true,
        placeholder: 'Control plane <panel@example.test>',
        schema: mailboxSchema,
      }),
      field({
        name: 'to',
        kind: 'text',
        required: true,
        placeholder: 'ops@example.test, astreinte@example.test',
        schema: mailboxListSchema,
      }),
      field({
        name: 'rejectUnauthorized',
        kind: 'boolean',
        defaultValue: true,
        schema: z.boolean().default(true),
      }),
    ],
  },
  telegram: {
    kind: 'telegram',
    fields: [
      field({
        name: 'botToken',
        kind: 'password',
        required: true,
        secret: true,
        placeholder: '123456789:AA…',
        schema: z.string().trim().min(10).max(200),
      }),
      field({
        name: 'chatId',
        kind: 'text',
        required: true,
        placeholder: '-1001234567890',
        schema: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .regex(/^(-?\d+|@[A-Za-z0-9_]{3,})$/, 'Identifiant numérique ou @nom_public attendu'),
      }),
      field({
        name: 'apiBaseUrl',
        kind: 'text',
        placeholder: 'https://api.telegram.org',
        schema: httpUrlSchema,
      }),
    ],
  },
  discord: {
    kind: 'discord',
    fields: [
      field({
        name: 'webhookUrl',
        kind: 'password',
        required: true,
        secret: true,
        placeholder: 'https://discord.com/api/webhooks/…',
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
        kind: 'text',
        placeholder: 'Control plane',
        schema: z.string().trim().max(80),
      }),
    ],
  },
  webhook: {
    kind: 'webhook',
    fields: [
      field({
        name: 'url',
        kind: 'text',
        required: true,
        placeholder: 'https://hooks.example.test/control-plane',
        schema: httpUrlSchema,
      }),
      field({
        name: 'token',
        kind: 'password',
        secret: true,
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
export type PresentedNotificationField = {
  name: string;
  label: string;
  kind: NotificationFieldKind;
  required: boolean;
  secret: boolean;
  placeholder: string | null;
  help: string | null;
  options: NotificationFieldOption[] | null;
  defaultValue: string | number | boolean | null;
};

export type PresentedNotificationChannel = {
  kind: NotificationChannelKind;
  label: string;
  description: string;
  prerequisite: string;
  fields: PresentedNotificationField[];
};

/**
 * C'est ici, et seulement ici, que la structure rencontre les mots. La langue
 * vient de l'appelant — le panel la tire de `settings.locale`. Le défaut garde
 * l'ancien appel compilable et rend exactement le français d'avant.
 */
export function presentNotificationChannels(
  language: UiLanguage = DEFAULT_UI_LANGUAGE,
): PresentedNotificationChannel[] {
  return notificationChannelDescriptors().map((descriptor) => ({
    kind: descriptor.kind,
    label: t(language, `${descriptor.kind}.label`),
    description: t(language, `${descriptor.kind}.description`),
    prerequisite: t(language, `${descriptor.kind}.prerequisite`),
    fields: descriptor.fields.map((entry) => ({
      name: entry.name,
      label: t(language, `${descriptor.kind}.${entry.name}.label` as keyof typeof fr),
      kind: entry.kind,
      required: entry.required,
      secret: entry.secret,
      placeholder: entry.placeholder,
      help: optionalText(language, `${descriptor.kind}.${entry.name}.help`),
      options:
        entry.options === null
          ? null
          : entry.options.map((value) => ({
              value,
              label: t(
                language,
                `${descriptor.kind}.${entry.name}.option.${value}` as keyof typeof fr,
              ),
            })),
      defaultValue: entry.defaultValue,
    })),
  }));
}
