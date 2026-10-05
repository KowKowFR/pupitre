import {
  DEFAULT_UI_LANGUAGE,
  renderMessage,
  type Translated,
  type UiLanguage,
} from '../i18n.js';
import { z } from 'zod';
import { invalid } from '../validation.js';

/**
 * Catalog of notification channels — the *data* part of the abstraction.
 *
 * The same split as `Scanner`, `DeploymentDriver` and the AI providers: on one
 * side a declarative description (here), on the other a factory that
 * instantiates (`./index.js`). The separation is not cosmetic — this module
 * only depends on Zod, which lets the Next panel, the routes and `@pupitre/db`
 * know the channels and their fields **without pulling `nodemailer`** into their
 * graph. It is the rule already applied to `ssh2` and the AI SDK.
 *
 * Each channel describes its configuration fields itself: type, requirement,
 * help, default value, **and its Zod schema**. The screen is built from this
 * list and the routes validate from it. The intended consequence: there is no
 * `if (kind === 'smtp')` anywhere — neither in the UI, nor in the routes, nor in
 * the database. Adding a fifth channel is one entry here and one class in the
 * factory.
 */

export const NOTIFICATION_CHANNEL_KINDS = ['smtp', 'telegram', 'discord', 'webhook'] as const;

export const notificationChannelKindSchema = z.enum(NOTIFICATION_CHANNEL_KINDS);
export type NotificationChannelKind = z.infer<typeof notificationChannelKindSchema>;

/**
 * How the screen must render the field. It is indeed the *field*'s type, not
 * the channel's: a `switch` on it in the UI is legitimate, there are four ways
 * to enter a value and they depend on no protocol.
 */
export type NotificationFieldKind = 'text' | 'password' | 'number' | 'boolean' | 'select';

export type NotificationFieldOption = { readonly value: string; readonly label: string };

/**
 * A field, reduced to its **structure**. Its texts — label, help, option labels
 * — live in the dictionary further down, under keys derived from the channel
 * and the field's name. A descriptor therefore has no language, and
 * `presentNotificationChannels()` is the only place that asks for one.
 *
 * The `placeholder` stays here, and it is deliberate: `smtp.example.test` or
 * `ops@example.test` are example values, not sentences. Translating them would
 * have produced nothing different.
 */
export type NotificationFieldDescriptor = {
  readonly name: string;
  readonly kind: NotificationFieldKind;
  readonly required: boolean;
  /**
   * The field is a secret: encrypted in its own column (AES-256-GCM under
   * `MASTER_KEY`), never returned by the API, never logged, never in the audit
   * log. The same pattern as `targets.encrypted_credential`.
   */
  readonly secret: boolean;
  readonly placeholder: string | null;
  /** Accepted values of a `select`. They are keys: they are not translated. */
  readonly options: readonly string[] | null;
  readonly defaultValue: string | number | boolean | null;
  /** The field's validation. The form's shape and the route's come from here. */
  readonly schema: z.ZodTypeAny;
};

export type NotificationChannelDescriptor = {
  readonly kind: NotificationChannelKind;
  readonly fields: readonly NotificationFieldDescriptor[];
};

// ─── shared validation bricks ─────────────────────────────────────────────────

const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Nom d’hôte ou adresse IP attendu');

/**
 * An address, possibly named: `a@b.test` or `Ops <a@b.test>`. Deliberately
 * permissive on the local part — RFC 5321 is too, and refusing a valid address
 * costs more here than accepting a wrong one, which the SMTP server will reject
 * anyway and say so.
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
    invalid('notifications.emailList'),
  );

/**
 * An http(s) URL, validated by `new URL()` inside a `try`.
 *
 * The `try` is not decorative: Zod v4 runs **every** link of a chain, including
 * after a failure. A `refine` that calls `new URL()` on an input that is not a
 * URL therefore throws an exception Zod does not catch — and the route returns
 * 500 instead of the expected 422. Observed, not assumed.
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

/** Splits a list of addresses entered on a single line. */
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

// ─── the catalog's words ──────────────────────────────────────────────────────

/**
 * What the configuration screen shows of a channel: its name, what it does,
 * what one must have fetched beforehand, then each field's label and help. The
 * keys are derived from the channel and the field's name — the same convention
 * as the configuration paths.
 *
 * Not in it, deliberately: the option values (`starttls`, `implicit`), the
 * protocol and service names (Telegram, Discord, @BotFather), the input
 * examples, and the Zod messages — those travel in `details`, which the panel
 * does not show.
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
 * A composite key's text, or `null` if there is none.
 *
 * The keys are built from the channel and the field's name: the compiler
 * therefore cannot know which one carries help. Absence is a valid answer — a
 * field without help shows none.
 */
function optionalText(language: UiLanguage, key: string): string | null {
  return Object.hasOwn(fr, key) ? t(language, key as keyof typeof fr) : null;
}

// ─── the catalog ──────────────────────────────────────────────────────────────

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

// ─── a channel's configuration ────────────────────────────────────────────────

/** A channel's configuration values. Flat, on purpose: nothing to nest here. */
export type ChannelConfig = Record<string, string | number | boolean>;

function shapeOf(fields: readonly NotificationFieldDescriptor[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const entry of fields) {
    shape[entry.name] = entry.required ? entry.schema : entry.schema.optional();
  }
  // `strip`: an unknown field is removed, not refused. A channel's form can send
  // another's fields while the type is being changed.
  return z.object(shape);
}

/** **Non-secret** fields. Stored in clear in `notification_channels.config`. */
export function channelConfigSchema(kind: NotificationChannelKind): z.ZodTypeAny {
  return shapeOf(CATALOG[kind].fields.filter((entry) => !entry.secret));
}

/** **Secret** fields. Encrypted as a block in `notification_channels.encrypted_secrets`. */
export function channelSecretsSchema(kind: NotificationChannelKind): z.ZodTypeAny {
  return shapeOf(CATALOG[kind].fields.filter((entry) => entry.secret));
}

/** Names of a channel's secret fields — used to say *which* are filled in. */
export function channelSecretFields(kind: NotificationChannelKind): string[] {
  return CATALOG[kind].fields.filter((entry) => entry.secret).map((entry) => entry.name);
}

// ─── presentation ─────────────────────────────────────────────────────────────

/**
 * The catalog rid of its Zod schemas, hence serializable as JSON.
 *
 * The screen is built from this shape: it writes the name of no channel and no
 * field. A `RegExp` or a function does not survive `JSON.stringify` — letting
 * them through would give a silent `{}` on the client side, and an empty form
 * without an error.
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
 * It is here, and only here, that the structure meets the words. The language
 * comes from the caller — the panel takes it from `settings.locale`. The default
 * keeps the old call compiling and returns exactly the French from before.
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
