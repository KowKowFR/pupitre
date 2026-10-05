import { Readable } from 'node:stream';
import { assertEgressAllowed, EgressRefusedError } from '../../egress.js';
import type { S3DestinationConfig, S3DestinationSecrets } from '../destinations.js';
import { BackupStoreError, probeKey, type BackupStore, type StoredObject } from './types.js';
import type { UiLanguage } from '../../i18n.js';
import { backupSay, type BackupSay } from '../messages.js';
import { EMPTY_SHA256, encodeKeyPath, sha256Hex, signV4 } from './sigv4.js';

/**
 * Une destination compatible S3 — AWS, Scaleway, Backblaze B2, Wasabi, MinIO.
 *
 * L'envoi est découpé en parties de 16 Mio (envoi multipartie au-delà) :
 * une archive de plusieurs gigaoctets ne tient jamais en mémoire, et chaque
 * partie est signée avec l'empreinte de son contenu.
 */

const PART_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;

const decodeXml = (value: string) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

function xmlValues(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((match) =>
    decodeXml(match[1] ?? ''),
  );
}

type RequestOptions = {
  query?: Record<string, string>;
  body?: Buffer;
  headers?: Record<string, string>;
};

export class S3BackupStore implements BackupStore {
  readonly kind = 's3' as const;
  private readonly base: URL;

  private readonly say: BackupSay;

  constructor(
    private readonly config: S3DestinationConfig,
    private readonly secrets: S3DestinationSecrets,
    private readonly doFetch: typeof fetch = fetch,
    private readonly language: UiLanguage = 'fr',
  ) {
    this.base = new URL(config.endpoint);
    this.say = backupSay(language);
  }

  private objectKey(key: string): string {
    return this.config.prefix ? `${this.config.prefix}/${key}` : key;
  }

  /** L'hôte et le chemin encodé d'une clé, selon le style d'adressage. */
  private locate(key: string | null): { host: string; path: string } {
    const basePath = this.base.pathname.replace(/\/+$/, '');
    const encoded = key === null ? '' : `/${encodeKeyPath(key)}`;
    if (this.config.pathStyle) {
      return { host: this.base.host, path: `${basePath}/${this.config.bucket}${encoded}` || '/' };
    }
    return {
      host: `${this.config.bucket}.${this.base.host}`,
      path: `${basePath}${encoded}` || '/',
    };
  }

  private async request(
    method: string,
    key: string | null,
    options: RequestOptions = {},
  ): Promise<Response> {
    const { host, path } = this.locate(key);
    const payloadHash = options.body ? sha256Hex(options.body) : EMPTY_SHA256;
    const headers = signV4({
      method,
      host,
      path,
      query: options.query,
      headers: options.headers,
      payloadHash,
      region: this.config.region,
      accessKeyId: this.secrets.accessKeyId,
      secretAccessKey: this.secrets.secretAccessKey,
    });
    delete headers.host;
    const search = new URLSearchParams(options.query ?? {}).toString().replace(/\+/g, '%20');
    const url = `${this.base.protocol}//${host}${path}${search ? `?${search}` : ''}`;
    try {
      await assertEgressAllowed(url);
    } catch (error) {
      if (!(error instanceof EgressRefusedError)) throw error;
      throw new BackupStoreError(`S3 : ${error.describe(this.language)}`, error);
    }
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method,
        headers,
        body: options.body ? new Uint8Array(options.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new BackupStoreError(
        `stockage S3 injoignable (${this.base.host}) : ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    if (!response.ok && response.status !== 404) {
      const text = await response.text().catch(() => '');
      const code = xmlValues(text, 'Code')[0];
      const message = xmlValues(text, 'Message')[0];
      throw new BackupStoreError(
        `S3 ${method} ${key ?? this.config.bucket} : HTTP ${response.status}` +
          (code ? ` ${code}` : '') +
          (message ? ` — ${message}` : ''),
      );
    }
    return response;
  }

  async put(key: string, body: Readable): Promise<number> {
    const objectKey = this.objectKey(key);
    let buffered: Buffer[] = [];
    let size = 0;
    let total = 0;
    let uploadId: string | null = null;
    const parts: string[] = [];

    const flushPart = async () => {
      const part = Buffer.concat(buffered);
      buffered = [];
      size = 0;
      if (uploadId === null) {
        const created = await this.request('POST', objectKey, { query: { uploads: '' } });
        uploadId = xmlValues(await created.text(), 'UploadId')[0] ?? null;
        if (!uploadId) throw new BackupStoreError(this.say('s3.noUploadId'));
      }
      const response = await this.request('PUT', objectKey, {
        query: { partNumber: String(parts.length + 1), uploadId },
        body: part,
      });
      const etag = response.headers.get('etag');
      if (!etag) throw new BackupStoreError(this.say('s3.noEtag'));
      parts.push(etag);
    };

    try {
      for await (const chunk of body) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        buffered.push(data);
        size += data.length;
        total += data.length;
        if (size >= PART_BYTES) await flushPart();
      }
      if (uploadId === null) {
        // Tout a tenu dans une partie : un seul PUT.
        await this.request('PUT', objectKey, { body: Buffer.concat(buffered) });
        return total;
      }
      if (size > 0) await flushPart();
      const completion =
        '<CompleteMultipartUpload>' +
        parts
          .map(
            (etag, index) =>
              `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag></Part>`,
          )
          .join('') +
        '</CompleteMultipartUpload>';
      const done = await this.request('POST', objectKey, {
        query: { uploadId },
        body: Buffer.from(completion),
        headers: { 'content-type': 'application/xml' },
      });
      // S3 peut répondre 200 avec une erreur dans le corps.
      const text = await done.text();
      if (text.includes('<Error>')) {
        throw new BackupStoreError(
          this.say('s3.assembleRefused', { detail: xmlValues(text, 'Message')[0] ?? text }),
        );
      }
      return total;
    } catch (error) {
      if (uploadId !== null) {
        await this.request('DELETE', objectKey, { query: { uploadId } }).catch(() => undefined);
      }
      throw error;
    }
  }

  async get(key: string): Promise<Readable> {
    const response = await this.request('GET', this.objectKey(key));
    if (response.status === 404 || !response.body) {
      throw new BackupStoreError(`S3 : « ${key} » introuvable`);
    }
    return Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  }

  async remove(key: string): Promise<void> {
    await this.request('DELETE', this.objectKey(key));
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const objects: StoredObject[] = [];
    const strip = this.config.prefix ? `${this.config.prefix}/` : '';
    let token: string | null = null;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix: this.objectKey(prefix) };
      if (token) query['continuation-token'] = token;
      const response = await this.request('GET', null, { query });
      const xml = await response.text();
      for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
        const key = xmlValues(block, 'Key')[0] ?? '';
        objects.push({
          key: key.startsWith(strip) ? key.slice(strip.length) : key,
          bytes: Number(xmlValues(block, 'Size')[0] ?? 0),
          modifiedAt: xmlValues(block, 'LastModified')[0] ?? null,
        });
      }
      token =
        xmlValues(xml, 'IsTruncated')[0] === 'true'
          ? (xmlValues(xml, 'NextContinuationToken')[0] ?? null)
          : null;
    } while (token);
    return objects;
  }

  async removePrefix(prefix: string): Promise<number> {
    const objects = await this.list(prefix);
    for (const object of objects) await this.remove(object.key);
    return objects.length;
  }

  async check(): Promise<void> {
    const key = probeKey();
    await this.put(key, Readable.from([Buffer.from('pupitre')]));
    const back = await this.get(key);
    const chunks: Buffer[] = [];
    for await (const chunk of back) chunks.push(Buffer.from(chunk as Uint8Array));
    await this.remove(key);
    if (Buffer.concat(chunks).toString() !== 'pupitre') {
      throw new BackupStoreError(this.say('s3.probeMismatch'));
    }
  }

  async close(): Promise<void> {}
}
