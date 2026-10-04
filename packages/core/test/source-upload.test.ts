import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { crc32, gzipSync } from 'node:zlib';
import { list, type ReadEntry } from 'tar';
import {
  SourceArchiveRejected,
  checkDockerfiles,
  expectedDockerfiles,
  inspectSourceArchive,
  looksLikeDockerfile,
  sniffArchiveFormat,
  sourceArchiveLabel,
  type SourceArchiveFormat,
  type SourceArchiveRejection,
} from '../src/sources/upload/index.js';
import { parseAppSpec } from '../src/spec/index.js';

/**
 * An uploaded archive only passes if nothing escapes from it. The booby-trapped
 * archives are made here byte by byte: the `tar` and `zip` tools refuse to write
 * most of these traps, and that is precisely what we want to test.
 */

const work = mkdtempSync(join(tmpdir(), 'pupitre-upload-test-'));
after(() => rmSync(work, { recursive: true, force: true }));
let counter = 0;

// ─── fabrique de tar ─────────────────────────────────────────────────────────

type TarItem = {
  name: string;
  /** 0 file, 1 hard link, 2 symbolic link, 3 device, 5 folder, 6 pipe. */
  type?: '0' | '1' | '2' | '3' | '5' | '6';
  data?: string;
  link?: string;
  mode?: number;
};

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function tarBytes(items: TarItem[]): Buffer {
  const blocks: Buffer[] = [];
  for (const item of items) {
    const data = Buffer.from(item.data ?? '');
    const header = Buffer.alloc(512);
    header.write(item.name, 0, 100, 'utf8');
    header.write(octal(item.mode ?? (item.type === '5' ? 0o755 : 0o644), 8), 100);
    header.write(octal(0, 8), 108);
    header.write(octal(0, 8), 116);
    header.write(octal(item.type === '0' || !item.type ? data.length : 0, 12), 124);
    header.write(octal(1_700_000_000, 12), 136);
    header.write('        ', 148);
    header.write(item.type ?? '0', 156);
    header.write(item.link ?? '', 157, 100, 'utf8');
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header);
    if ((item.type ?? '0') === '0' && data.length > 0) {
      blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// ─── fabrique de zip ─────────────────────────────────────────────────────────

type ZipItem = { name: string; data?: string; mode?: number; encrypted?: boolean; unix?: boolean };

function zipBytes(items: ZipItem[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name, 'utf8');
    const plain = Buffer.from(item.data ?? '');
    const crc = crc32(plain);
    // An encrypted entry (ZipCrypto) carries twelve more header bytes.
    const data = item.encrypted ? Buffer.concat([Buffer.alloc(12, 7), plain]) : plain;
    const flags = (item.encrypted ? 0x1 : 0) | 0x800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((item.unix ?? true) ? 3 << 8 : 0) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((item.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// ─── outillage ───────────────────────────────────────────────────────────────

function file(bytes: Buffer): string {
  counter += 1;
  const path = join(work, `entree-${counter}`);
  writeFileSync(path, bytes);
  return path;
}

async function inspect(
  bytes: Buffer,
  format: SourceArchiveFormat,
  options: Parameters<typeof inspectSourceArchive>[3] = {},
) {
  counter += 1;
  const output = join(work, `sortie-${counter}.tar.gz`);
  const report = await inspectSourceArchive(file(bytes), format, output, {
    workDir: work,
    ...options,
  });
  return { report, output };
}

async function rejected(
  bytes: Buffer,
  format: SourceArchiveFormat,
  code: SourceArchiveRejection,
  options: Parameters<typeof inspectSourceArchive>[3] = {},
) {
  await assert.rejects(inspect(bytes, format, options), (error: unknown) => {
    assert.ok(error instanceof SourceArchiveRejected, String(error));
    assert.equal(error.code, code, `${error.code} (${error.detail})`);
    return true;
  });
}

/** What the returned archive contains: path → type and permissions. */
async function entries(
  path: string,
): Promise<Map<string, { type: string; mode: number; link?: string }>> {
  const found = new Map<string, { type: string; mode: number; link?: string }>();
  await list({
    file: path,
    onReadEntry: (entry: ReadEntry) => {
      found.set(entry.path.replace(/\/$/, ''), {
        type: entry.type,
        mode: (entry.mode ?? 0) & 0o777,
        ...(entry.linkpath ? { link: entry.linkpath } : {}),
      });
      entry.resume();
    },
  });
  return found;
}

const gz = (items: TarItem[]) => gzipSync(tarBytes(items));

// ─── les tests ───────────────────────────────────────────────────────────────

describe('uploaded archive — the format is read from the bytes', () => {
  it('recognizes tar.gz, zip and tar, and nothing else', () => {
    assert.equal(sniffArchiveFormat(gz([{ name: 'a', data: 'x' }])), 'tar.gz');
    assert.equal(sniffArchiveFormat(zipBytes([{ name: 'a', data: 'x' }])), 'zip');
    assert.equal(sniffArchiveFormat(zipBytes([])), 'zip');
    assert.equal(sniffArchiveFormat(tarBytes([{ name: 'a', data: 'x' }])), 'tar');
    assert.equal(sniffArchiveFormat(Buffer.from('FROM node:22\n')), null);
    assert.equal(sniffArchiveFormat(Buffer.from([0x42, 0x5a, 0x68])), null);
  });

  it('the name is only a label', () => {
    assert.equal(sourceArchiveLabel('C:\\Users\\moi\\mon-app.zip'), 'mon-app.zip');
    assert.equal(sourceArchiveLabel('../../etc/passwd'), 'passwd');
    assert.equal(sourceArchiveLabel('a\u0000b\nc.tgz'), 'abc.tgz');
    assert.equal(sourceArchiveLabel(''), 'archive');
    assert.equal(sourceArchiveLabel(null), 'archive');
  });
});

describe('uploaded archive — a healthy archive becomes a clean archive', () => {
  it('removes the leading folder, keeps the execute bit, leaves .git aside', async () => {
    const { report, output } = await inspect(
      gz([
        { name: 'mon-app/', type: '5' },
        { name: 'mon-app/Dockerfile', data: 'FROM busybox\n' },
        { name: 'mon-app/app/index.html', data: '<h1>ok</h1>' },
        { name: 'mon-app/entree.sh', data: '#!/bin/sh\n', mode: 0o4755 },
        { name: 'mon-app/.git/config', data: '[core]' },
        { name: 'mon-app/derniere', type: '2', link: 'app' },
      ]),
      'tar.gz',
      { expected: ['Dockerfile'] },
    );
    assert.equal(report.strippedRoot, 'mon-app');
    assert.equal(report.files, 3);
    assert.equal(report.symlinks, 1);
    assert.equal(report.skippedEntries, 1);
    assert.deepEqual(report.dockerfiles, ['Dockerfile']);
    assert.equal(report.unpackedBytes, 13 + 11 + 10);

    const found = await entries(output);
    assert.ok(found.has('source/Dockerfile'));
    assert.ok(found.has('source/app/index.html'));
    assert.ok(![...found.keys()].some((path) => path.includes('.git')));
    assert.ok(![...found.keys()].some((path) => path.includes('mon-app')));
    // setuid drops, execute stays.
    assert.equal(found.get('source/entree.sh')?.mode, 0o755);
    assert.equal(found.get('source/Dockerfile')?.mode, 0o644);
    assert.equal(found.get('source/derniere')?.type, 'SymbolicLink');
    assert.equal(found.get('source/derniere')?.link, 'app');
  });

  it('keeps the leading folder when the expected Dockerfiles are already there', async () => {
    const { report, output } = await inspect(
      gz([{ name: 'app/Dockerfile', data: 'FROM busybox\n' }]),
      'tar.gz',
      { expected: ['app/Dockerfile'] },
    );
    assert.equal(report.strippedRoot, null);
    assert.ok((await entries(output)).has('source/app/Dockerfile'));
  });

  it('reads an uncompressed tar', async () => {
    const { report } = await inspect(tarBytes([{ name: 'Dockerfile', data: 'FROM x\n' }]), 'tar');
    assert.equal(report.files, 1);
    assert.equal(report.strippedRoot, null);
  });

  it('reads a zip: Unix permissions, internal link, __MACOSX ignored', async () => {
    const { report, output } = await inspect(
      zipBytes([
        { name: 'site/', mode: 0o040755 },
        { name: 'site/Dockerfile', data: 'FROM nginx\n' },
        { name: 'site/run.sh', data: 'echo\n', mode: 0o100755 },
        { name: 'site/courant', data: 'run.sh', mode: 0o120777 },
        { name: '__MACOSX/site/._run.sh', data: 'x' },
      ]),
      'zip',
      { expected: ['Dockerfile'] },
    );
    assert.equal(report.strippedRoot, 'site');
    assert.equal(report.skippedEntries, 1);
    const found = await entries(output);
    assert.equal(found.get('source/run.sh')?.mode, 0o755);
    assert.equal(found.get('source/courant')?.type, 'SymbolicLink');
  });

  it('a tar made on a Mac: its AppleDouble files and .DS_Store do not prevent removing the leading folder', async () => {
    // What `tar czf code.tar.gz site` produces under macOS: a `._name` next to each
    // entry that carries extended attributes — including `._site`, next to the
    // leading folder, which suggested two roots.
    const { report, output } = await inspect(
      gz([
        { name: '._site', data: 'Mac OS X        ATTR' },
        { name: 'site/', type: '5' },
        { name: 'site/._Dockerfile', data: 'Mac OS X        ATTR' },
        { name: 'site/Dockerfile', data: 'FROM busybox\n' },
        { name: 'site/.DS_Store', data: 'Bud1' },
        { name: 'site/www/', type: '5' },
        { name: 'site/www/._index.html', data: 'Mac OS X        ATTR' },
        { name: 'site/www/index.html', data: '<h1>ok</h1>' },
      ]),
      'tar.gz',
      { expected: ['Dockerfile'] },
    );
    assert.equal(report.strippedRoot, 'site');
    assert.deepEqual(report.dockerfiles, ['Dockerfile']);
    assert.equal(report.files, 2);
    assert.equal(report.skippedEntries, 4);
    const found = [...(await entries(output)).keys()];
    assert.ok(found.includes('source/Dockerfile'));
    assert.ok(!found.some((path) => /(^|\/)(\._|\.DS_Store$)/.test(path)), found.join(', '));
  });

  it('a zip made under Windows: no Unix permissions, ordinary files', async () => {
    const { report } = await inspect(
      zipBytes([{ name: 'Dockerfile', data: 'FROM x\n', unix: false, mode: 0x20 }]),
      'zip',
    );
    assert.equal(report.files, 1);
  });
});

describe('uploaded archive — nothing escapes from it', () => {
  it('absolute paths and climbing up', async () => {
    await rejected(gz([{ name: '/etc/cron.d/piege', data: 'x' }]), 'tar.gz', 'absolute_path');
    await rejected(gz([{ name: '../hors-release', data: 'x' }]), 'tar.gz', 'parent_path');
    await rejected(gz([{ name: 'app/../../evade', data: 'x' }]), 'tar.gz', 'parent_path');
    await rejected(zipBytes([{ name: '../evade', data: 'x' }]), 'zip', 'parent_path');
    await rejected(zipBytes([{ name: '/evade', data: 'x' }]), 'zip', 'absolute_path');
  });

  it('a link pointing outside', async () => {
    await rejected(gz([{ name: 'l', type: '2', link: '/etc/shadow' }]), 'tar.gz', 'link_outside');
    await rejected(gz([{ name: 'a/l', type: '2', link: '../../..' }]), 'tar.gz', 'link_outside');
    await rejected(
      zipBytes([{ name: 'l', data: '/root/.ssh', mode: 0o120777 }]),
      'zip',
      'link_outside',
    );
  });

  it('a link that only leaves the code once the leading folder is removed', async () => {
    // `my-app/l → ../compose.yml` stays inside the archive, but would point at the
    // release's control files once placed under `source/`.
    await rejected(
      gz([
        { name: 'mon-app/Dockerfile', data: 'FROM x\n' },
        { name: 'mon-app/l', type: '2', link: '../compose.yml' },
      ]),
      'tar.gz',
      'link_outside',
      { expected: ['Dockerfile'] },
    );
  });

  it('an entry written through a link of the archive', async () => {
    await rejected(
      gz([
        { name: 'cache', type: '2', link: 'vrai' },
        { name: 'cache/piege', data: 'x' },
      ]),
      'tar.gz',
      'link_traversal',
    );
  });

  it('hard links, devices, pipes', async () => {
    await rejected(gz([{ name: 'l', type: '1', link: '/etc/passwd' }]), 'tar.gz', 'hardlink');
    await rejected(gz([{ name: 'disque', type: '3' }]), 'tar.gz', 'special_file');
    await rejected(gz([{ name: 'tube', type: '6' }]), 'tar.gz', 'special_file');
  });

  it('two entries at the same place', async () => {
    await rejected(
      gz([
        { name: 'a', data: '1' },
        { name: 'a', data: '2' },
      ]),
      'tar.gz',
      'duplicate',
    );
    await rejected(
      gz([
        { name: 'a', data: '1' },
        { name: 'a/b', data: '2' },
      ]),
      'tar.gz',
      'duplicate',
    );
  });

  it('the caps: number of entries, decompressed size', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: 'x' }));
    await rejected(gz(many), 'tar.gz', 'too_many_entries', { maxEntries: 3 });
    await rejected(zipBytes(many), 'zip', 'too_many_entries', { maxEntries: 3 });
    await rejected(gz([{ name: 'gros', data: 'x'.repeat(64) }]), 'tar.gz', 'too_large', {
      maxUnpackedBytes: 32,
    });
    await rejected(zipBytes([{ name: 'gros', data: 'x'.repeat(64) }]), 'zip', 'too_large', {
      maxUnpackedBytes: 32,
    });
  });

  it('encrypted, empty, unreadable', async () => {
    await rejected(zipBytes([{ name: 'a', data: 'x', encrypted: true }]), 'zip', 'encrypted');
    await rejected(zipBytes([]), 'zip', 'empty');
    await rejected(gz([{ name: '.git/config', data: 'x' }]), 'tar.gz', 'empty');
    await rejected(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02]), 'tar.gz', 'corrupt');
    await rejected(
      gzipSync(Buffer.from('pas une archive tar, mais du texte')),
      'tar.gz',
      'corrupt',
    );
    await rejected(Buffer.from('PK\x03\x04 tronqué'), 'zip', 'corrupt');
  });
});

describe('uploaded archive — each service finds its Dockerfile', () => {
  const spec = parseAppSpec({
    name: 'boutique',
    version: '1.0.0',
    services: [
      {
        name: 'web',
        source: { type: 'dockerfile', context: './front/' },
        port: 3000,
        exposed: true,
      },
      {
        name: 'api',
        source: { type: 'dockerfile', context: 'api', dockerfile: 'build/prod.image' },
        port: 8080,
      },
      { name: 'db', source: { type: 'image', ref: 'postgres:16' }, port: 5432 },
    ],
  });

  it('the expected paths, relative to the code’s root', () => {
    assert.deepEqual(expectedDockerfiles(spec), [
      { service: 'web', path: 'front/Dockerfile' },
      { service: 'api', path: 'api/build/prod.image' },
    ]);
  });

  it('found, missing, or to check on the machine', () => {
    assert.deepEqual(checkDockerfiles(spec, ['front/Dockerfile']), [
      { service: 'web', path: 'front/Dockerfile', status: 'found' },
      { service: 'api', path: 'api/build/prod.image', status: 'unknown' },
    ]);
    assert.equal(checkDockerfiles(spec, [])[0]?.status, 'missing');
  });

  it('what looks like a Dockerfile', () => {
    for (const name of ['Dockerfile', 'app/Dockerfile.prod', 'api.dockerfile', 'Containerfile']) {
      assert.ok(looksLikeDockerfile(name), name);
    }
    for (const name of ['docker-compose.yml', 'README.md', 'Dockerfiles/readme']) {
      assert.ok(!looksLikeDockerfile(name), name);
    }
  });
});
