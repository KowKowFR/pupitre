import { setAuditFailureReporter } from '@tp/db';
import { pino } from 'pino';
import { env } from './env.js';

/** Champs jamais journalisés, quelle que soit leur profondeur. */
const REDACTED = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
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
  'OPENROUTER_API_KEY',
];

const paths = [
  ...REDACTED,
  ...REDACTED.map((key) => `*.${key}`),
  ...REDACTED.map((key) => `*.*.${key}`),
];

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'worker', workerId: env.WORKER_ID },
  redact: { paths, censor: '[redacted]' },
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

setAuditFailureReporter((error, entry) => {
  logger.error(
    { err: error, action: entry.action, resourceType: entry.resourceType },
    "échec d'écriture dans audit_logs",
  );
});

export type Logger = typeof logger;
