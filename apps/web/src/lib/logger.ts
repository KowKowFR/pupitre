import 'server-only';
import { setAuditFailureReporter } from '@tp/db';
import { pino } from 'pino';

/**
 * Champs jamais journalisés, quelle que soit leur profondeur.
 * Le wildcard `*.x` couvre un niveau ; on liste aussi les racines usuelles.
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
  'authorization',
  'cookie',
  'MASTER_KEY',
  'BETTER_AUTH_SECRET',
  // Une variable par fournisseur d'IA : la liste suit le catalogue de
  // `@tp/core/ai`. Un fournisseur ajouté sans sa variable ici ferait fuir sa clé
  // dans un log de configuration.
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  // Clé du fournisseur d'IA, sous les noms qu'elle peut porter selon la couche
  // traversée : corps de PATCH, colonne Drizzle, colonne SQL, argument de
  // `createModel()`.
  'aiApiKey',
  'apiKey',
  'aiApiKeyEncrypted',
  'ai_api_key_encrypted',
  // Second facteur : le secret TOTP voyage aussi sous forme d'URI `otpauth://`,
  // qui le porte en clair dans sa query string. Les codes de secours sont des
  // équivalents du mot de passe — ils ne se journalisent pas davantage.
  'totpURI',
  'totpUri',
  'backupCodes',
  'backupCode',
  'twoFactorSecret',
  'backup_codes',
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

// Un échec d'écriture d'audit ne casse pas la requête, mais doit être visible.
setAuditFailureReporter((error, entry) => {
  logger.error(
    { err: error, action: entry.action, resourceType: entry.resourceType },
    "échec d'écriture dans audit_logs",
  );
});
