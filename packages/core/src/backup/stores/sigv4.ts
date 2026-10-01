import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, pour S3 et ses compatibles.
 *
 * Écrite ici plutôt qu'importée : le SDK AWS pèse plusieurs mégaoctets pour les
 * cinq requêtes dont on a besoin, et la signature tient en quelques lignes que
 * le test confronte au vecteur officiel d'AWS.
 */

export const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** Encodage RFC 3986 tel que S3 l'attend : tout sauf `A-Za-z0-9-_.~`. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Une clé d'objet, segment par segment : les `/` restent des séparateurs. */
export function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

export type SignInput = {
  method: string;
  host: string;
  /** Chemin **déjà encodé** (`/bucket/apps/blog/x.pupb`). */
  path: string;
  query?: Record<string, string>;
  /** En-têtes à signer, noms en minuscules ; `host` et `x-amz-*` sont ajoutés. */
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  date?: Date;
};

export function canonicalQuery(query: Record<string, string> = {}): string {
  return Object.entries(query)
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

/** Rend les en-têtes à envoyer, `authorization` compris. */
export function signV4(input: SignInput): Record<string, string> {
  const date = input.date ?? new Date();
  const amzDate = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method,
    input.path,
    canonicalQuery(input.query),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
