import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import {
  BACKUP_HEADER_BYTES,
  BackupFormatError,
  LocalBackupStore,
  createDecryptStream,
  createEncryptStream,
  decryptBuffer,
  encryptBuffer,
  signV4,
} from '../src/backup/index.js';
import {
  DEFAULT_BACKUP_RETENTION,
  backupFolder,
  databaseEngineOf,
  describeBackupDestination,
  dumpCommand,
  expiredBackups,
  hasBackupData,
  hotCopiedServices,
  parseAppSpec,
  parseBackupDestination,
  pieceFile,
  planBackup,
  restoreCommand,
} from '../src/index.js';

/**
 * Les sauvegardes : le format chiffré, la signature S3, le plan, la rétention,
 * une destination. Les transferts réels — MinIO, SFTP, volumes Docker et K3s —
 * se vérifient à part, contre de vraies machines.
 */

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

function chunked(data: Buffer, size: number): Readable {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += size)
    parts.push(data.subarray(offset, offset + size));
  return Readable.from(parts);
}

describe('format .pupb', () => {
  it('chiffre et déchiffre en flux, quel que soit le découpage', async () => {
    const plain = Buffer.alloc(300_000);
    for (let index = 0; index < plain.length; index += 1) plain[index] = (index * 31) % 251;
    const sealed = await collect(chunked(plain, 7_777).pipe(createEncryptStream(KEY)));
    assert.equal(sealed.subarray(0, 4).toString(), 'PUPB');
    assert.equal(sealed.length, plain.length + BACKUP_HEADER_BYTES + 16);
    // Découpage hostile : morceaux plus petits que l'en-tête et que l'étiquette.
    const back = await collect(chunked(sealed, 5).pipe(createDecryptStream(KEY)));
    assert.ok(back.equals(plain));
  });

  it('deux chiffrements du même contenu ne se ressemblent pas', async () => {
    const a = await encryptBuffer(Buffer.from('même contenu'), KEY);
    const b = await encryptBuffer(Buffer.from('même contenu'), KEY);
    assert.notDeepEqual(a, b);
    assert.equal((await decryptBuffer(a, KEY)).toString(), 'même contenu');
  });

  it('refuse un fichier altéré, tronqué, ou chiffré sous une autre clé', async () => {
    const sealed = await encryptBuffer(Buffer.from('données importantes'), KEY);
    const tampered = Buffer.from(sealed);
    tampered[BACKUP_HEADER_BYTES + 2] = (tampered[BACKUP_HEADER_BYTES + 2] ?? 0) ^ 1;
    await assert.rejects(decryptBuffer(tampered, KEY), BackupFormatError);
    await assert.rejects(
      decryptBuffer(sealed.subarray(0, sealed.length - 3), KEY),
      BackupFormatError,
    );
    await assert.rejects(decryptBuffer(sealed, OTHER_KEY), BackupFormatError);
    // L'en-tête est authentifié lui aussi : changer le sel, c'est changer la clé.
    const header = Buffer.from(sealed);
    header[6] = (header[6] ?? 0) ^ 1;
    await assert.rejects(decryptBuffer(header, KEY), BackupFormatError);
    await assert.rejects(
      decryptBuffer(Buffer.from('pas une sauvegarde du tout'), KEY),
      BackupFormatError,
    );
  });

  it('chiffre aussi un contenu vide', async () => {
    const sealed = await encryptBuffer(Buffer.alloc(0), KEY);
    assert.equal((await decryptBuffer(sealed, KEY)).length, 0);
  });
});

describe('signature S3 (SigV4)', () => {
  it('reproduit le vecteur officiel d’AWS (GET Object)', () => {
    // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    const headers = signV4({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      date: new Date('2013-05-24T00:00:00Z'),
    });
    assert.equal(
      headers.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});

const spec = parseAppSpec({
  name: 'blog',
  version: '1.0.0',
  services: [
    {
      name: 'db',
      source: { type: 'image', ref: 'postgres:16-alpine' },
      port: 5432,
      volumes: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }],
    },
    {
      name: 'web',
      source: { type: 'image', ref: 'ghost:5' },
      port: 2368,
      exposed: true,
      dependsOn: ['db'],
      volumes: [{ name: 'content', mountPath: '/var/lib/ghost/content' }],
    },
    { name: 'cache', source: { type: 'image', ref: 'redis:7' }, port: 6379 },
  ],
});

describe('le plan', () => {
  it('reconnaît les bases dont il sait l’outil — et pas les autres', () => {
    assert.equal(databaseEngineOf('postgres:16-alpine'), 'postgres');
    assert.equal(databaseEngineOf('docker.io/library/postgres:15'), 'postgres');
    assert.equal(databaseEngineOf('postgis/postgis:16-3.4'), 'postgres');
    assert.equal(databaseEngineOf('mariadb:11'), 'mysql');
    assert.equal(databaseEngineOf('mysql:8.4'), 'mysql');
    assert.equal(databaseEngineOf('mongo:7'), 'mongo');
    assert.equal(databaseEngineOf('bitnami/postgresql:16'), null);
    assert.equal(databaseEngineOf('ghcr.io/acme/postgres:16'), null);
    assert.equal(databaseEngineOf('redis:7'), null);
  });

  it('à chaud : export de la base, archive des autres volumes', () => {
    assert.deepEqual(planBackup(spec, 'hot'), [
      { kind: 'dump', service: 'db', engine: 'postgres' },
      { kind: 'volume', service: 'web', volume: 'content', mountPath: '/var/lib/ghost/content' },
    ]);
  });

  it('à l’arrêt : tous les volumes, aucun export', () => {
    assert.deepEqual(planBackup(spec, 'stop'), [
      { kind: 'volume', service: 'db', volume: 'data', mountPath: '/var/lib/postgresql/data' },
      { kind: 'volume', service: 'web', volume: 'content', mountPath: '/var/lib/ghost/content' },
    ]);
    assert.deepEqual(hotCopiedServices(spec), ['web']);
    assert.equal(hasBackupData(spec), true);
  });

  it('nomme fichiers et dossiers sans ambiguïté', () => {
    assert.equal(
      pieceFile({ kind: 'volume', service: 'web', volume: 'content', mountPath: '/x' }),
      'volume-web-content.tar.gz.pupb',
    );
    assert.equal(
      pieceFile({ kind: 'dump', service: 'db', engine: 'postgres' }),
      'dump-db-postgres.gz.pupb',
    );
    const at = new Date('2026-10-01T03:00:00.123Z');
    assert.equal(
      backupFolder('application', 'blog', '1a2b3c4d-0000-4000-8000-000000000000', at),
      'apps/blog/2026-10-01T03-00-00Z-1a2b3c4d',
    );
    assert.equal(
      backupFolder('panel', null, 'ffffffff-0000-4000-8000-000000000000', at),
      'panel/2026-10-01T03-00-00Z-ffffffff',
    );
  });

  it('lit les identifiants dans l’environnement du conteneur, jamais en clair', () => {
    for (const engine of ['postgres', 'mysql', 'mongo'] as const) {
      assert.doesNotMatch(dumpCommand(engine), /password\s*=\s*['"][^$]/i);
      assert.ok(restoreCommand(engine).length > 0);
    }
    assert.match(
      dumpCommand('mysql'),
      /grep -Ev '\^\(mysql\|sys\|information_schema\|performance_schema\)\$'/,
    );
  });
});

describe('rétention', () => {
  const at = (iso: string) => new Date(iso);
  const backups = [
    // Trois le même jour : la plus récente du jour seule compte pour « jour ».
    { id: 'a', createdAt: at('2026-10-01T03:00:00Z') },
    { id: 'b', createdAt: at('2026-10-01T10:00:00Z') },
    { id: 'c', createdAt: at('2026-10-01T15:00:00Z') },
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `d${index}`,
      createdAt: new Date(Date.UTC(2026, 8, 30 - index, 3)),
    })),
    { id: 'old', createdAt: at('2025-01-15T03:00:00Z') },
  ];

  it('garde les plus récentes, puis une par jour, semaine, mois', () => {
    const expired = new Set(expiredBackups(backups, DEFAULT_BACKUP_RETENTION).map((b) => b.id));
    // Les trois du jour : `keepLast` = 3.
    for (const id of ['a', 'b', 'c']) assert.ok(!expired.has(id), id);
    // Les six jours précédents complètent les sept quotidiennes.
    for (let index = 0; index < 6; index += 1) assert.ok(!expired.has(`d${index}`), `d${index}`);
    // Au-delà, seules survivent les plus récentes de leur semaine ou de leur mois.
    assert.ok(expired.has('d6') || expired.has('d7'));
    assert.ok(!expired.has('old') || DEFAULT_BACKUP_RETENTION.monthly < 7);
    assert.ok(expired.size > 0);
  });

  it('ne rend rien tant qu’il y a de la place', () => {
    assert.deepEqual(expiredBackups(backups.slice(0, 3), DEFAULT_BACKUP_RETENTION), []);
    assert.deepEqual(expiredBackups([], DEFAULT_BACKUP_RETENTION), []);
  });

  it('keepLast seul : les N plus récentes, et rien d’autre', () => {
    const expired = expiredBackups(backups, { keepLast: 2, daily: 0, weekly: 0, monthly: 0 });
    assert.equal(expired.length, backups.length - 2);
    assert.ok(!expired.some((backup) => backup.id === 'c' || backup.id === 'b'));
  });
});

describe('destinations', () => {
  it('valide réglages et secrets selon le genre', () => {
    const s3 = parseBackupDestination(
      's3',
      {
        endpoint: 'https://s3.fr-par.scw.cloud',
        region: 'fr-par',
        bucket: 'pupitre-backups',
        prefix: '/prod/',
      },
      { accessKeyId: 'AK', secretAccessKey: 'SK' },
    );
    assert.equal(s3.kind === 's3' && s3.config.prefix, 'prod');
    assert.throws(() =>
      parseBackupDestination(
        's3',
        { endpoint: 'ftp://x', bucket: 'b' },
        { accessKeyId: 'a', secretAccessKey: 'b' },
      ),
    );
    assert.throws(() => parseBackupDestination('sftp', { host: 'nas', username: 'u' }, {}));
    assert.throws(() =>
      parseBackupDestination(
        'sftp',
        { host: 'nas', username: 'u', path: '../etc' },
        { password: 'p' },
      ),
    );
    assert.throws(() => parseBackupDestination('local', { path: 'relatif' }, {}));
    assert.equal(
      describeBackupDestination({
        kind: 'sftp',
        config: { host: 'nas.local', username: 'pupitre', port: 22, path: 'backups' },
      }),
      'sftp://pupitre@nas.local:22/backups',
    );
  });
});

describe('destination « dossier monté »', () => {
  it('dépose, liste, relit et efface — sans jamais sortir du dossier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pupitre-store-'));
    try {
      const store = new LocalBackupStore({ path: root });
      await store.check();
      const bytes = await store.put('apps/blog/x/a.pupb', Readable.from([Buffer.from('bonjour')]));
      assert.equal(bytes, 7);
      await store.put('apps/blog/x/b.pupb', Readable.from([Buffer.from('!')]));
      await store.put('apps/other/y/c.pupb', Readable.from([Buffer.from('?')]));
      assert.deepEqual((await store.list('apps/blog/')).map((object) => object.key).sort(), [
        'apps/blog/x/a.pupb',
        'apps/blog/x/b.pupb',
      ]);
      assert.equal((await collect(await store.get('apps/blog/x/a.pupb'))).toString(), 'bonjour');
      assert.equal(await store.removePrefix('apps/blog/x/'), 2);
      assert.deepEqual(await readdir(join(root, 'apps')), ['other']);
      await assert.rejects(store.put('../evasion', Readable.from([Buffer.from('x')])));
      await assert.rejects(store.get('apps/absent'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
