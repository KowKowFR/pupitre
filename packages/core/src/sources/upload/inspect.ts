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
  SOURCE_UPLOAD_SKIPPED,
  looksLikeDockerfile,
  type SourceArchiveFormat,
  type SourceArchiveRejection,
  type SourceArchiveReport,
} from '../upload-model.js';

/**
 * La lecture d'une archive téléversée, et son remplacement par une archive
 * propre.
 *
 * L'archive n'est pas décompressée par `tar -x` ni par une bibliothèque qui
 * écrirait ce qu'on lui donne : chaque entrée passe ici, est jugée, puis
 * écrite par ce code — ou l'archive entière est refusée. Ce qui est refusé :
 *
 *   - un chemin absolu, ou qui remonte (`..`) ;
 *   - un lien symbolique qui pointe hors de l'archive, ou qu'une entrée
 *     suivante traverserait pour écrire ailleurs ;
 *   - un lien dur, un périphérique, un tube nommé ;
 *   - deux entrées au même chemin, un fichier qui servirait de dossier ;
 *   - au-delà de `maxEntries` entrées ou de `maxUnpackedBytes` décompressés.
 *
 * Les droits sont ramenés à `0644` ou `0755` (le bit d'exécution survit, rien
 * d'autre) ; `.git/` et `__MACOSX/` sont laissés de côté. Une archive faite
 * d'un seul dossier perd ce dossier de tête, sauf si les Dockerfiles attendus
 * se trouvent sans le retirer.
 *
 * L'archive rendue est un `tar.gz` dont tout vit sous `source/` : le driver la
 * décompresse avec `--strip-components=1`, comme celle d'un commit GitHub.
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
  /** Les Dockerfiles que l'AppSpec attend, relatifs à la racine du code. */
  expected?: readonly string[];
  maxEntries?: number;
  maxUnpackedBytes?: number;
  /** Où travailler ; un dossier temporaire du système par défaut. */
  workDir?: string;
};

type Kind = 'file' | 'dir' | 'symlink';

const MAX_PATH = 4096;
const MAX_COMPONENT = 255;
const MAX_LINK_TARGET = 4096;

/**
 * Un chemin d'entrée, ramené à sa forme relative — ou la raison de son refus.
 * `null` : l'entrée ne nomme rien (la racine `./`), on l'ignore.
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

/** La cible d'un lien, résolue depuis son dossier : elle doit rester dans l'archive. */
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

/** L'arbre décompressé, tenu à jour entrée après entrée. */
class Tree {
  readonly kinds = new Map<string, Kind>();
  readonly links: { path: string; target: string }[] = [];
  /** Les écritures en cours : un refus les ferme, pour que rien ne reste suspendu. */
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

  /** `true` : l'entrée est à laisser de côté (`.git/`, `__MACOSX/`). */
  skips(path: string): boolean {
    const skipped = path
      .split('/')
      .some((part) => (SOURCE_UPLOAD_SKIPPED as readonly string[]).includes(part));
    if (skipped) this.skipped += 1;
    return skipped;
  }

  /**
   * Réserve un chemin pour une entrée de ce type, après avoir vérifié qu'il
   * ne traverse aucun lien et qu'aucun fichier n'y sert de dossier.
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
   * Écrit un fichier depuis son flux, en comptant ses octets contre le
   * plafond : le compteur est un maillon de la chaîne, pas un écouteur posé à
   * côté — un écouteur `data` mettrait le flux en marche avant que la chaîne
   * ne soit branchée, et ce qui était en tampon serait perdu pour le fichier.
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

  /** Ferme ce qui s'écrit encore : l'archive est refusée, plus rien n'arrivera. */
  abort(): void {
    for (const stream of this.open) stream.destroy();
    this.open.clear();
  }

  /** Un lien symbolique, créé seulement à la fin : rien ne s'écrit à travers. */
  link(path: string, target: string): void {
    assertLinkInside(path, target);
    this.claim(path, 'symlink');
    this.links.push({ path, target });
  }

  /**
   * Crée les liens, une fois la racine choisie : un lien doit rester dans le
   * code **tel qu'il sera déposé**. Dans `mon-app/`, `lien → ../compose.yml`
   * reste dans l'archive mais sortirait du code une fois `mon-app/` retiré —
   * il viserait les fichiers de pilotage de la release.
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

// ─── tar et tar.gz ───────────────────────────────────────────────────────────

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

/** Une erreur des bibliothèques, ramenée à un refus qu'on sait dire. */
function asRejection(error: unknown): SourceArchiveRejected {
  if (error instanceof SourceArchiveRejected) return error;
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause instanceof SourceArchiveRejected) return cause;
  const message = error instanceof Error ? error.message : String(error);
  // Les noms que yauzl refuse lui-même, avant qu'on ne les voie.
  if (/^absolute path/i.test(message)) return new SourceArchiveRejected('absolute_path', message);
  if (/^invalid relative path/i.test(message)) {
    return new SourceArchiveRejected('parent_path', message);
  }
  return new SourceArchiveRejected('corrupt', message.slice(0, 300));
}

// ─── l'ensemble ──────────────────────────────────────────────────────────────

/**
 * Lit `input`, le juge, et écrit dans `output` l'archive propre à déposer.
 * Lève `SourceArchiveRejected` au premier refus ; rien ne reste sur le disque.
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

    // Un seul dossier en tête : c'est l'emballage (`mon-app/…`), sauf si les
    // Dockerfiles attendus se trouvent sans le retirer.
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
