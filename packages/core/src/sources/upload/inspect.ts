import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { Transform, type Readable, type Writable } from 'node:stream';
import { Parser, create, type ReadEntry } from 'tar';
import yauzl from 'yauzl';
import {
  DOCKERFILE_LIST_MAX,
  SOURCE_UPLOAD_MAX_ENTRIES,
  SOURCE_UPLOAD_MAX_UNPACKED_BYTES,
  isSkippedSourcePath,
  looksLikeDockerfile,
  type SourceArchiveFormat,
  type SourceArchiveRejection,
  type SourceArchiveReport,
} from '../upload-model.js';

/**
 * Reading an uploaded archive, and replacing it with a clean archive.
 *
 * The archive is not unpacked by `tar -x` nor by a library that would write
 * whatever it is given: each entry goes through here, is judged, then written
 * by this code — or the whole archive is refused. What is refused:
 *
 *   - an absolute path, or one that climbs up (`..`);
 *   - a symbolic link pointing outside the archive, or that a following entry
 *     would traverse to write elsewhere;
 *   - a hard link, a device, a named pipe;
 *   - two entries at the same path, a file that would serve as a folder;
 *   - beyond `maxEntries` entries or `maxUnpackedBytes` decompressed.
 *
 * Permissions are brought down to `0644` or `0755` (the execute bit survives,
 * nothing else); `.git/`, `__MACOSX/`, `.DS_Store` and macOS `tar`'s AppleDouble
 * files (`._*`) are left aside. An archive made of a single folder loses that
 * leading folder, unless the expected Dockerfiles are found without removing it.
 *
 * The returned archive is a `tar.gz` where everything lives under `source/`: the
 * driver unpacks it with `--strip-components=1`, like a GitHub commit's.
 */

export class SourceArchiveRejected extends Error {
  constructor(
    readonly code: SourceArchiveRejection,
    readonly detail: string | null = null,
  ) {
    super(detail ? `${code} : ${detail}` : code);
    this.name = 'SourceArchiveRejected';
  }
}

export type InspectOptions = {
  /** The Dockerfiles the AppSpec expects, relative to the code's root. */
  expected?: readonly string[];
  maxEntries?: number;
  maxUnpackedBytes?: number;
  /** Where to work; a system temporary folder by default. */
  workDir?: string;
};

type Kind = 'file' | 'dir' | 'symlink';

const MAX_PATH = 4096;
const MAX_COMPONENT = 255;
const MAX_LINK_TARGET = 4096;

/**
 * An entry's path, brought to its relative form — or the reason for refusing
 * it. `null`: the entry names nothing (the `./` root), it is ignored.
 */
export function entryPath(raw: string): string | null {
  if (raw.includes('\0')) throw new SourceArchiveRejected('invalid_name', raw.replace(/\0/g, '␀'));
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new SourceArchiveRejected('absolute_path', raw);
  }
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) throw new SourceArchiveRejected('parent_path', raw);
  if (parts.length === 0) return null;
  const path = parts.join('/');
  if (
    Buffer.byteLength(path) > MAX_PATH ||
    parts.some((part) => Buffer.byteLength(part) > MAX_COMPONENT)
  ) {
    throw new SourceArchiveRejected('invalid_name', `${path.slice(0, 120)}…`);
  }
  return path;
}

/** A link's target, resolved from its folder: it must stay inside the archive. */
export function assertLinkInside(path: string, target: string): void {
  if (target === '' || target.includes('\0') || Buffer.byteLength(target) > MAX_LINK_TARGET) {
    throw new SourceArchiveRejected('invalid_name', `${path} → ${target.slice(0, 120)}`);
  }
  if (target.startsWith('/') || /^[A-Za-z]:/.test(target)) {
    throw new SourceArchiveRejected('link_outside', `${path} → ${target}`);
  }
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) {
    throw new SourceArchiveRejected('link_outside', `${path} → ${target}`);
  }
}

/** The unpacked tree, kept up to date entry after entry. */
class Tree {
  readonly kinds = new Map<string, Kind>();
  readonly links: { path: string; target: string }[] = [];
  /** The writes in progress: a refusal closes them, so that nothing stays hanging. */
  readonly open = new Set<Writable>();
  entries = 0;
  skipped = 0;
  bytes = 0;

  constructor(
    readonly root: string,
    readonly maxEntries: number,
    readonly maxBytes: number,
  ) {}

  count(): void {
    this.entries += 1;
    if (this.entries > this.maxEntries) {
      throw new SourceArchiveRejected('too_many_entries', String(this.maxEntries));
    }
  }

  /** `true`: the entry is to be left aside (`.git/`, `__MACOSX/`, `._*`, `.DS_Store`). */
  skips(path: string): boolean {
    const skipped = isSkippedSourcePath(path);
    if (skipped) this.skipped += 1;
    return skipped;
  }

  /**
   * Reserves a path for an entry of this type, after checking that it traverses
   * no link and that no file serves as a folder there.
   */
  claim(path: string, kind: Kind): void {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const parent = parts.slice(0, depth).join('/');
      const existing = this.kinds.get(parent);
      if (existing === 'symlink') throw new SourceArchiveRejected('link_traversal', path);
      if (existing === 'file') throw new SourceArchiveRejected('duplicate', path);
      if (!existing) this.kinds.set(parent, 'dir');
    }
    const existing = this.kinds.get(path);
    if (existing && !(existing === 'dir' && kind === 'dir')) {
      throw new SourceArchiveRejected('duplicate', path);
    }
    this.kinds.set(path, kind);
  }

  async directory(path: string): Promise<void> {
    this.claim(path, 'dir');
    await mkdir(join(this.root, path), { recursive: true, mode: 0o755 });
  }

  /**
   * Writes a file from its stream, counting its bytes against the cap: the
   * counter is a link of the chain, not a listener set beside it — a `data`
   * listener would start the stream before the chain is plugged in, and what was
   * buffered would be lost for the file.
   */
  async file(path: string, mode: number | undefined, content: Readable): Promise<void> {
    this.claim(path, 'file');
    const parent = posix.dirname(path);
    if (parent !== '.') await mkdir(join(this.root, parent), { recursive: true, mode: 0o755 });
    const executable = mode !== undefined && (mode & 0o111) !== 0;
    await new Promise<void>((resolve, reject) => {
      const counter = new Transform({
        transform: (chunk: Buffer, _encoding, done) => {
          this.bytes += chunk.length;
          if (this.bytes > this.maxBytes) {
            done(new SourceArchiveRejected('too_large', String(this.maxBytes)));
          } else {
            done(null, chunk);
          }
        },
      });
      const out = createWriteStream(join(this.root, path), {
        flags: 'wx',
        mode: executable ? 0o755 : 0o644,
      });
      this.open.add(counter);
      this.open.add(out);
      let failed = false;
      const fail = (error: unknown) => {
        if (failed) return;
        failed = true;
        content.unpipe(counter);
        content.resume();
        counter.destroy();
        out.destroy();
        reject(error);
      };
      content.on('error', fail);
      counter.on('error', fail);
      out.on('error', fail);
      out.on('close', () => {
        this.open.delete(counter);
        this.open.delete(out);
        if (!failed) resolve();
      });
      content.pipe(counter).pipe(out);
    });
  }

  /** Closes what is still being written: the archive is refused, nothing more will come. */
  abort(): void {
    for (const stream of this.open) stream.destroy();
    this.open.clear();
  }

  /** A symbolic link, created only at the end: nothing is written through it. */
  link(path: string, target: string): void {
    assertLinkInside(path, target);
    this.claim(path, 'symlink');
    this.links.push({ path, target });
  }

  /**
   * Creates the links, once the root is chosen: a link must stay inside the code
   * **as it will be placed**. In `my-app/`, `link → ../compose.yml` stays inside
   * the archive but would leave the code once `my-app/` is removed — it would
   * point at the release's control files.
   */
  async finishLinks(strippedRoot: string | null): Promise<void> {
    for (const { path, target } of this.links) {
      if (strippedRoot) {
        const resolved = posix.normalize(posix.join(posix.dirname(path), target));
        if (resolved !== strippedRoot && !resolved.startsWith(`${strippedRoot}/`)) {
          throw new SourceArchiveRejected('link_outside', `${path} → ${target}`);
        }
      }
      const parent = posix.dirname(path);
      if (parent !== '.') await mkdir(join(this.root, parent), { recursive: true, mode: 0o755 });
      await symlink(target, join(this.root, path));
    }
  }
}

// ─── tar and tar.gz ──────────────────────────────────────────────────────────

const TAR_FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);

async function readTar(input: string, tree: Tree): Promise<void> {
  let rejection: unknown = null;
  const pending: Promise<void>[] = [];

  await new Promise<void>((resolve) => {
    const parser = new Parser({
      strict: true,
      onReadEntry: (entry: ReadEntry) => {
        if (rejection) {
          entry.resume();
          return;
        }
        try {
          tree.count();
          const path = entryPath(entry.path);
          if (path === null || tree.skips(path)) {
            entry.resume();
            return;
          }
          if (entry.type === 'Directory') {
            entry.resume();
            pending.push(tree.directory(path).catch(stop));
          } else if (TAR_FILE_TYPES.has(entry.type)) {
            pending.push(tree.file(path, entry.mode, entry as unknown as Readable).catch(stop));
          } else if (entry.type === 'SymbolicLink') {
            entry.resume();
            tree.link(path, entry.linkpath ?? '');
          } else if (entry.type === 'Link') {
            throw new SourceArchiveRejected('hardlink', path);
          } else {
            throw new SourceArchiveRejected('special_file', `${path} (${entry.type})`);
          }
        } catch (error) {
          entry.resume();
          stop(error);
        }
      },
    });

    function stop(error: unknown) {
      rejection ??= error;
      tree.abort();
      parser.abort(error instanceof Error ? error : new Error(String(error)));
    }

    parser.on('error', (error: unknown) => {
      rejection ??= error;
      tree.abort();
      resolve();
    });
    parser.on('end', () => resolve());
    const stream = createReadStream(input);
    stream.on('error', (error) => {
      rejection ??= error;
      resolve();
    });
    stream.pipe(parser as unknown as NodeJS.WritableStream);
  });

  await Promise.allSettled(pending);
  if (rejection) throw asRejection(rejection);
}

// ─── zip ─────────────────────────────────────────────────────────────────────

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const MADE_BY_UNIX = 3;

async function readZip(input: string, tree: Tree): Promise<void> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(input, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: false,
    });
  } catch (error) {
    throw asRejection(error);
  }
  try {
    if (zip.entryCount > tree.maxEntries) {
      throw new SourceArchiveRejected('too_many_entries', String(tree.maxEntries));
    }
    for await (const entry of zip.eachEntry()) {
      tree.count();
      const path = entryPath(entry.fileName);
      if (path === null || tree.skips(path)) continue;
      if (entry.isEncrypted()) throw new SourceArchiveRejected('encrypted', path);

      const unixMode =
        entry.versionMadeBy >> 8 === MADE_BY_UNIX ? entry.externalFileAttributes >>> 16 : 0;
      if (entry.fileName.endsWith('/')) {
        await tree.directory(path);
      } else if ((unixMode & S_IFMT) === S_IFLNK) {
        if (entry.uncompressedSize > MAX_LINK_TARGET) {
          throw new SourceArchiveRejected('invalid_name', path);
        }
        const target = await readAll(await zip.openReadStreamPromise(entry));
        tree.link(path, target.toString('utf8'));
      } else if ((unixMode & S_IFMT) !== 0 && (unixMode & S_IFMT) !== 0o100000) {
        throw new SourceArchiveRejected('special_file', path);
      } else {
        if (tree.bytes + entry.uncompressedSize > tree.maxBytes) {
          throw new SourceArchiveRejected('too_large', String(tree.maxBytes));
        }
        await tree.file(path, unixMode & 0o777, await zip.openReadStreamPromise(entry));
      }
    }
  } catch (error) {
    tree.abort();
    throw asRejection(error);
  } finally {
    zip.close();
  }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** A library error, brought down to a refusal we can phrase. */
function asRejection(error: unknown): SourceArchiveRejected {
  if (error instanceof SourceArchiveRejected) return error;
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause instanceof SourceArchiveRejected) return cause;
  const message = error instanceof Error ? error.message : String(error);
  // The names yauzl refuses itself, before we see them.
  if (/^absolute path/i.test(message)) return new SourceArchiveRejected('absolute_path', message);
  if (/^invalid relative path/i.test(message)) {
    return new SourceArchiveRejected('parent_path', message);
  }
  return new SourceArchiveRejected('corrupt', message.slice(0, 300));
}

// ─── l'ensemble ──────────────────────────────────────────────────────────────

/**
 * Reads `input`, judges it, and writes into `output` the clean archive to place.
 * Throws `SourceArchiveRejected` at the first refusal; nothing stays on the disk.
 */
export async function inspectSourceArchive(
  input: string,
  format: SourceArchiveFormat,
  output: string,
  options: InspectOptions = {},
): Promise<SourceArchiveReport> {
  const work = await mkdtemp(join(options.workDir ?? tmpdir(), 'pupitre-archive-'));
  const tree = new Tree(
    join(work, 'tree'),
    options.maxEntries ?? SOURCE_UPLOAD_MAX_ENTRIES,
    options.maxUnpackedBytes ?? SOURCE_UPLOAD_MAX_UNPACKED_BYTES,
  );
  try {
    await mkdir(tree.root, { mode: 0o755 });
    if (format === 'zip') await readZip(input, tree);
    else await readTar(input, tree);

    if (tree.kinds.size === 0) throw new SourceArchiveRejected('empty');

    // A single leading folder: it is the wrapping (`my-app/…`), unless the expected
    // Dockerfiles are found without removing it.
    const expected = options.expected ?? [];
    const top = [...tree.kinds.keys()].filter((path) => !path.includes('/'));
    const wrapper = top.length === 1 && tree.kinds.get(top[0]!) === 'dir' ? top[0]! : null;
    const asIs = expected.length > 0 && expected.every((path) => tree.kinds.has(path));
    const strippedRoot = wrapper && !asIs ? wrapper : null;
    await tree.finishLinks(strippedRoot);
    const base = strippedRoot ? join(tree.root, strippedRoot) : tree.root;
    const prefix = strippedRoot ? `${strippedRoot}/` : '';

    let files = 0;
    let directories = 0;
    let symlinks = 0;
    const dockerfiles: string[] = [];
    for (const [path, kind] of tree.kinds) {
      if (strippedRoot && (path === strippedRoot || !path.startsWith(prefix))) continue;
      const relative = path.slice(prefix.length);
      if (kind === 'dir') {
        directories += 1;
        continue;
      }
      if (kind === 'file') files += 1;
      else symlinks += 1;
      if (looksLikeDockerfile(relative) && dockerfiles.length < DOCKERFILE_LIST_MAX) {
        dockerfiles.push(relative);
      }
    }

    const names = (await readdir(base)).sort();
    if (names.length === 0) throw new SourceArchiveRejected('empty');
    await create(
      { gzip: true, file: output, cwd: base, portable: true, prefix: 'source', follow: false },
      names,
    );

    return {
      files,
      directories,
      symlinks,
      unpackedBytes: tree.bytes,
      strippedRoot,
      skippedEntries: tree.skipped,
      dockerfiles: dockerfiles.sort(),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
