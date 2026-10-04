import 'server-only';
import { setAuditFailureReporter } from '@pupitre/db';
import { pino } from 'pino';

/**
 * Fields never logged, whatever their depth. The `*.x` wildcard covers one level;
 * the usual roots are listed too.
 */
const REDACTED = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'sessionToken',
  'secret',
  'credential',
  'encryptedCredential',
  'privateKey',
  'passphrase',
  // The applications' secrets store: the encrypted value as well as the plain
  // value, under the names they carry depending on the layer crossed — PUT body,
  // Drizzle column, SQL column, resolved table passed to the rendering.
  'encryptedValue',
  'encrypted_value',
  'secretValue',
  'secretValues',
  'authorization',
  'cookie',
  'MASTER_KEY',
  'BETTER_AUTH_SECRET',
  // One variable per AI provider: the list follows `@pupitre/core/ai`'s catalog. A
  // provider added without its variable here would leak its key into a
  // configuration log.
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  // The AI provider's key, under the names it can carry depending on the layer
  // crossed: PATCH body, Drizzle column, SQL column, `createModel()` argument.
  'aiApiKey',
  'apiKey',
  'aiApiKeyEncrypted',
  'ai_api_key_encrypted',
  // Second factor: the TOTP secret also travels as an `otpauth://` URI, which
  // carries it in clear in its query string. The backup codes are password
  // equivalents — they are not logged either.
  'totpURI',
  'totpUri',
  'backupCodes',
  'backupCode',
  'twoFactorSecret',
  'backup_codes',
  // Notification channels: the secret fields of `@pupitre/core/notifications`'
  // catalog, under the names they carry depending on the layer crossed — POST/PATCH
  // body, resolved object passed to the channel, Drizzle column, SQL column.
  // `webhookUrl` is indeed a secret: a Discord webhook's URL contains its write
  // token.
  'botToken',
  'webhookUrl',
  'secrets',
  'encryptedSecrets',
  'encrypted_secrets',
];

const paths = [
  ...REDACTED,
  ...REDACTED.map((key) => `*.${key}`),
  ...REDACTED.map((key) => `*.*.${key}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'web' },
  redact: { paths, censor: '[redacted]' },
});

// An audit write failure does not break the request, but must be visible.
setAuditFailureReporter((error, entry) => {
  logger.error(
    { err: error, action: entry.action, resourceType: entry.resourceType },
    'audit_logs write failed',
  );
});
