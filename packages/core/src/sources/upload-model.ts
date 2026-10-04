import type { AppSpec } from '../spec/index.js';

/**
 * Le code d'une application, téléversé dans le panel : une archive `.tar.gz`,
 * `.tar` ou `.zip`.
 *
 * C'est l'autre voie d'entrée du code, à côté d'un dépôt lié — pour une
 * application créée par le formulaire, par l'IA, depuis le catalogue ou par
 * import d'un `compose.yml`, qui n'a pas de dépôt. L'archive n'apporte **que**
 * le code à construire : l'AppSpec reste celle du panel, un `pupitre.json`
 * qu'elle contiendrait est ignoré.
 *
 * Elle n'est jamais envoyée telle quelle sur une machine. Le worker la relit
 * entrée par entrée, refuse ce qui sortirait du dossier (chemins absolus, `..`,
 * liens qui pointent dehors ou qu'on traverserait, liens durs, fichiers
 * spéciaux), puis en refait une archive propre — celle que le driver dépose
 * dans `source/` de la release, exactement comme le code d'un commit.
 *
 * Module pur : le panel s'en sert pour reconnaître un format, et l'écran pour
 * dire ce qu'il en est. La lecture elle-même vit sous `@pupitre/core/source-upload`.
 */

/** Une archive téléversée ne dépasse pas cette taille. */
export const SOURCE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** Décompressée, pas davantage : une archive piégée qui gonfle s'arrête là. */
export const SOURCE_UPLOAD_MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

/** Ni plus d'entrées que ceci. */
export const SOURCE_UPLOAD_MAX_ENTRIES = 50_000;

/** Les dernières archives d'une application qu'on garde — de quoi redéployer une version récente. */
export const SOURCE_ARCHIVES_KEPT = 5;

/** Les octets d'une archive vivent en base par morceaux de cette taille. */
export const SOURCE_ARCHIVE_CHUNK_BYTES = 1024 * 1024;

/** Des noms qu'on n'emporte jamais : l'historique Git, les métadonnées du Finder. */
export const SOURCE_UPLOAD_SKIPPED = ['.git', '__MACOSX', '.DS_Store'] as const;

/**
 * Le préfixe des fichiers AppleDouble. Le `tar` de macOS en glisse un à côté de
 * chaque entrée qui porte des attributs étendus — `site/._Dockerfile`, et
 * `._site` à côté du dossier de tête, qui empêchait alors de le retirer. Ce ne
 * sont pas des fichiers du code.
 */
export const SOURCE_UPLOAD_APPLEDOUBLE_PREFIX = '._';

/** `true` : l'entrée, ou l'un des dossiers qui la contiennent, n'est pas du code. */
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
 * Le format, lu dans les premiers octets — jamais dans le nom du fichier ni
 * dans l'en-tête de la requête. 512 octets suffisent : la signature d'un `tar`
 * est à l'offset 257.
 */
export function sniffArchiveFormat(head: Uint8Array): SourceArchiveFormat | null {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'tar.gz';
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b) {
    // Une entrée locale, ou la fin d'une archive vide.
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
 * Pourquoi une archive est refusée. Un code et un détail brut (un chemin) :
 * la phrase appartient à l'écran, qui la dit dans la langue de l'instance.
 */
export const SOURCE_ARCHIVE_REJECTIONS = [
  /** Ni `tar.gz`, ni `tar`, ni `zip`. */
  'format',
  /** Illisible : tronquée, en-tête invalide, compression inconnue. */
  'corrupt',
  /** Une entrée chiffrée (zip protégé par mot de passe). */
  'encrypted',
  /** Rien à construire dedans. */
  'empty',
  'too_many_entries',
  /** Plus de `SOURCE_UPLOAD_MAX_UNPACKED_BYTES` une fois décompressée. */
  'too_large',
  'absolute_path',
  'parent_path',
  /** Un nom vide, trop long, ou qui porte un octet nul. */
  'invalid_name',
  /** Un lien symbolique qui pointe hors de l'archive. */
  'link_outside',
  /** Une entrée écrite *à travers* un lien symbolique de l'archive. */
  'link_traversal',
  'hardlink',
  /** Périphérique, tube nommé : rien à faire dans du code. */
  'special_file',
  /** Deux entrées au même chemin, ou un fichier qui sert aussi de dossier. */
  'duplicate',
] as const;
export type SourceArchiveRejection = (typeof SOURCE_ARCHIVE_REJECTIONS)[number];

/** Ce que la lecture a trouvé, une fois l'archive acceptée. */
export type SourceArchiveReport = {
  files: number;
  directories: number;
  symlinks: number;
  /** Octets des fichiers, décompressés. */
  unpackedBytes: number;
  /**
   * Le dossier de tête retiré, sans sa barre finale — `mon-app` pour une
   * archive faite d'un seul dossier `mon-app/`. `null` : rien de retiré.
   */
  strippedRoot: string | null;
  /** Entrées laissées de côté (`.git/`, `__MACOSX/`). */
  skippedEntries: number;
  /**
   * Les fichiers qui ressemblent à un Dockerfile, relatifs à la racine du code
   * (bornés à `DOCKERFILE_LIST_MAX`) : de quoi vérifier, au déploiement, qu'un
   * service trouvera le sien — même si l'AppSpec a changé depuis.
   */
  dockerfiles: string[];
};

export const DOCKERFILE_LIST_MAX = 500;

/** `Dockerfile`, `Dockerfile.prod`, `api.dockerfile`, `Containerfile`. */
export function looksLikeDockerfile(path: string): boolean {
  const name = path.split('/').at(-1) ?? '';
  return /^(docker|container)file([.-].*)?$/i.test(name) || /\.(docker|container)file$/i.test(name);
}

/** Un chemin relatif, sans `.` ni barres en trop : `./app//Dockerfile` → `app/Dockerfile`. */
export function cleanRelativePath(path: string): string {
  return path
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/');
}

/** Ce que chaque service construit attend de trouver dans le code. */
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
   * `found` : présent. `missing` : absent, et l'archive le dirait (le nom a
   * l'air d'un Dockerfile). `unknown` : un nom qu'on ne relève pas — la
   * construction le vérifiera sur la machine.
   */
  status: 'found' | 'missing' | 'unknown';
};

/** Chaque service construit trouve-t-il son Dockerfile dans l'archive ? */
export function checkDockerfiles(spec: AppSpec, dockerfiles: readonly string[]): DockerfileCheck[] {
  const present = new Set(dockerfiles);
  return expectedDockerfiles(spec).map(({ service, path }) => ({
    service,
    path,
    status: present.has(path) ? 'found' : looksLikeDockerfile(path) ? 'missing' : 'unknown',
  }));
}

/**
 * Le nom affiché d'une archive : le dernier segment de ce que le navigateur
 * a envoyé, sans caractère de contrôle, borné. Il n'est qu'une étiquette —
 * rien ne s'écrit jamais sous ce nom.
 */
export function sourceArchiveLabel(raw: string | null | undefined): string {
  const base = (raw ?? '').split(/[\\/]/).at(-1) ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (clean === '' ? 'archive' : clean).slice(0, 200);
}
