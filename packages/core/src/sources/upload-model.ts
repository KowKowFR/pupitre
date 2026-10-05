import type { AppSpec } from '../spec/index.js';

/**
 * An application's code, uploaded into the panel: a `.tar.gz`, `.tar` or `.zip`
 * archive.
 *
 * It is the other way in for code, next to a linked repository — for an
 * application created by the form, by AI, from the catalog or by importing a
 * `compose.yml`, which has no repository. The archive brings **only** the code
 * to build: the AppSpec stays the panel's, a `pupitre.json` it might contain is
 * ignored.
 *
 * It is never sent as is to a machine. The worker reads it entry by entry,
 * refuses what would leave the folder (absolute paths, `..`, links pointing
 * outside or that would be traversed, hard links, special files), then makes a
 * clean archive of it — the one the driver places in the release's `source/`,
 * exactly like a commit's code.
 *
 * A pure module: the panel uses it to recognize a format, and the screen to say
 * how things stand. The reading itself lives under `@pupitre/core/source-upload`.
 */

/** An uploaded archive does not exceed this size. */
export const SOURCE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** Decompressed, no more than this: a booby-trapped archive that swells stops there. */
export const SOURCE_UPLOAD_MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

/** Nor more entries than this. */
export const SOURCE_UPLOAD_MAX_ENTRIES = 50_000;

/** An application's latest archives that are kept — enough to redeploy a recent version. */
export const SOURCE_ARCHIVES_KEPT = 5;

/** An archive's bytes live in the database in chunks of this size. */
export const SOURCE_ARCHIVE_CHUNK_BYTES = 1024 * 1024;

/** Names never taken along: the Git history, the Finder's metadata. */
export const SOURCE_UPLOAD_SKIPPED = ['.git', '__MACOSX', '.DS_Store'] as const;

/**
 * The prefix of AppleDouble files. macOS's `tar` slips one next to each entry
 * that carries extended attributes — `site/._Dockerfile`, and `._site` next to
 * the leading folder, which then prevented removing it. They are not files of
 * the code.
 */
export const SOURCE_UPLOAD_APPLEDOUBLE_PREFIX = '._';

/** `true`: the entry, or one of the folders containing it, is not code. */
export function isSkippedSourcePath(path: string): boolean {
  return path
    .split('/')
    .some(
      (part) =>
        (SOURCE_UPLOAD_SKIPPED as readonly string[]).includes(part) ||
        part.startsWith(SOURCE_UPLOAD_APPLEDOUBLE_PREFIX),
    );
}

export const SOURCE_ARCHIVE_FORMATS = ['tar.gz', 'tar', 'zip'] as const;
export type SourceArchiveFormat = (typeof SOURCE_ARCHIVE_FORMATS)[number];

/**
 * The format, read from the first bytes — never from the file name or the
 * request header. 512 bytes are enough: a `tar`'s signature is at offset 257.
 */
export function sniffArchiveFormat(head: Uint8Array): SourceArchiveFormat | null {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'tar.gz';
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b) {
    // A local entry, or the end of an empty archive.
    if ((head[2] === 0x03 && head[3] === 0x04) || (head[2] === 0x05 && head[3] === 0x06)) {
      return 'zip';
    }
  }
  if (head.length >= 262) {
    const magic = String.fromCharCode(...head.subarray(257, 262));
    if (magic === 'ustar') return 'tar';
  }
  return null;
}

/**
 * Why an archive is refused. A code and a raw detail (a path): the sentence
 * belongs to the screen, which says it in the instance's language.
 */
export const SOURCE_ARCHIVE_REJECTIONS = [
  /** Neither `tar.gz`, nor `tar`, nor `zip`. */
  'format',
  /** Unreadable: truncated, invalid header, unknown compression. */
  'corrupt',
  /** An encrypted entry (password-protected zip). */
  'encrypted',
  /** Nothing to build in it. */
  'empty',
  'too_many_entries',
  /** More than `SOURCE_UPLOAD_MAX_UNPACKED_BYTES` once decompressed. */
  'too_large',
  'absolute_path',
  'parent_path',
  /** An empty name, too long, or carrying a null byte. */
  'invalid_name',
  /** A symbolic link pointing outside the archive. */
  'link_outside',
  /** An entry written *through* a symbolic link of the archive. */
  'link_traversal',
  'hardlink',
  /** Device, named pipe: nothing to do in code. */
  'special_file',
  /** Two entries at the same path, or a file that also serves as a folder. */
  'duplicate',
] as const;
export type SourceArchiveRejection = (typeof SOURCE_ARCHIVE_REJECTIONS)[number];

/** What the reading found, once the archive is accepted. */
export type SourceArchiveReport = {
  files: number;
  directories: number;
  symlinks: number;
  /** Bytes of the files, decompressed. */
  unpackedBytes: number;
  /**
   * The leading folder removed, without its trailing slash — `my-app` for an
   * archive made of a single `my-app/` folder. `null`: nothing removed.
   */
  strippedRoot: string | null;
  /** Entries left aside (`.git/`, `__MACOSX/`). */
  skippedEntries: number;
  /**
   * The files that look like a Dockerfile, relative to the root of the code
   * (capped at `DOCKERFILE_LIST_MAX`): enough to check, at deployment, that a
   * service will find its own — even if the AppSpec has changed since.
   */
  dockerfiles: string[];
};

export const DOCKERFILE_LIST_MAX = 500;

/** `Dockerfile`, `Dockerfile.prod`, `api.dockerfile`, `Containerfile`. */
export function looksLikeDockerfile(path: string): boolean {
  const name = path.split('/').at(-1) ?? '';
  return /^(docker|container)file([.-].*)?$/i.test(name) || /\.(docker|container)file$/i.test(name);
}

/** A relative path, without `.` or extra slashes: `./app//Dockerfile` → `app/Dockerfile`. */
export function cleanRelativePath(path: string): string {
  return path
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/');
}

/** What each built service expects to find in the code. */
export function expectedDockerfiles(spec: AppSpec): { service: string; path: string }[] {
  return spec.services.flatMap((service) =>
    service.source.type === 'dockerfile'
      ? [
          {
            service: service.name,
            path: cleanRelativePath(`${service.source.context}/${service.source.dockerfile}`),
          },
        ]
      : [],
  );
}

export type DockerfileCheck = {
  service: string;
  path: string;
  /**
   * `found`: present. `missing`: absent, and the archive would show it (the name
   * looks like a Dockerfile). `unknown`: a name we do not record — the build will
   * check it on the machine.
   */
  status: 'found' | 'missing' | 'unknown';
};

/** Does each built service find its Dockerfile in the archive? */
export function checkDockerfiles(spec: AppSpec, dockerfiles: readonly string[]): DockerfileCheck[] {
  const present = new Set(dockerfiles);
  return expectedDockerfiles(spec).map(({ service, path }) => ({
    service,
    path,
    status: present.has(path) ? 'found' : looksLikeDockerfile(path) ? 'missing' : 'unknown',
  }));
}

/**
 * An archive's displayed name: the last segment of what the browser sent,
 * without control characters, capped. It is only a label — nothing is ever
 * written under that name.
 */
export function sourceArchiveLabel(raw: string | null | undefined): string {
  const base = (raw ?? '').split(/[\\/]/).at(-1) ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (clean === '' ? 'archive' : clean).slice(0, 200);
}
