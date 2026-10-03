/**
 * `SourceProvider` — la quatrième abstraction, à côté de `DeploymentDriver`,
 * `ProxyProvider` et `Scanner`.
 *
 * Elle répond à une seule question : **d'où vient le code d'une application**
 * quand ce n'est pas l'opérateur qui le colle dans le panel. Un dépôt Git
 * hébergé (GitHub, Gitea et Forgejo aujourd'hui, GitLab demain) porte à sa racine — ou
 * dans le dossier de l'application, pour un monorepo — un `pupitre.json` :
 * l'AppSpec de l'application, versionnée avec son code.
 *
 * ── Ce que le dépôt décide, et ce qu'il ne décide pas ───────────────────────
 * Le dépôt dit **quoi** : l'AppSpec, rien de plus, validée par le même schéma
 * Zod que partout ailleurs. Il ne dit jamais **où** ni **quand** — les cibles,
 * le runtime et le mode de déclenchement vivent dans le panel, sous RBAC.
 * Sinon, quiconque peut pousser sur la branche choisirait où son code tourne.
 * Et il ne porte aucun script : même raison que la règle 4 pour le LLM.
 *
 * ── Pourquoi du polling ─────────────────────────────────────────────────────
 * Le panel est privé : aucun webhook ne peut l'atteindre. Le worker interroge
 * donc le fournisseur (connexions sortantes seulement), avec un ETag qui rend
 * la question « rien de nouveau ? » presque gratuite. Tout ce contrat se lit
 * dans ce sens : c'est Pupitre qui demande, jamais le fournisseur qui appelle.
 *
 * ── Critère de qualité ──────────────────────────────────────────────────────
 * Ajouter un fournisseur, c'est ajouter une classe qui implémente ce contrat,
 * et la ligne qui la fabrique depuis sa connexion (`registry.ts`). Rien d'autre
 * dans le worker ni dans le panel ne connaît son nom — sauf l'écran qui le
 * connecte, par nature propre à chacun (une GitHub App, un jeton Gitea).
 */

export const SOURCE_PROVIDER_KINDS = ['github', 'gitea'] as const;
export type SourceProviderKind = (typeof SOURCE_PROVIDER_KINDS)[number];

/**
 * Une connexion, ses secrets déchiffrés : ce dont la fabrique a besoin pour
 * construire son client (`createSourceProvider`). Ne se range nulle part.
 */
export type SourceConnectionSecrets =
  | { provider: 'github'; appId: number; privateKey: string; apiUrl: string | null }
  | { provider: 'gitea'; baseUrl: string; token: string };

/** Un dépôt, désigné comme le fournisseur le désigne : `propriétaire/nom`. */
export type RepositoryRef = {
  /** `owner/name`. */
  fullName: string;
  /**
   * L'installation de la GitHub App par laquelle Pupitre y a accès. `null`
   * chez un fournisseur qui n'en a pas : Gitea ouvre tout par son jeton.
   */
  installationId: number | null;
};

/** Réponse à « quel est le dernier commit de cette branche ? ». */
export type HeadResult =
  | { changed: false }
  | {
      changed: true;
      sha: string;
      /** À renvoyer à la question suivante : une réponse 304 ne coûte rien. */
      etag: string | null;
    };

/** Ce qui a changé entre deux commits. */
export type CompareResult =
  | { kind: 'files'; files: string[] }
  /**
   * La comparaison n'est pas fiable : trop de fichiers pour la liste, historique
   * réécrit (force-push), commit de base disparu. On traite alors tout comme
   * changé — redéployer à tort coûte moins cher que d'ignorer un vrai changement.
   */
  | { kind: 'unknown'; reason: string };

export type SourceCommit = {
  sha: string;
  message: string;
  /** L'auteur tel que le fournisseur le nomme (login si connu, sinon nom). */
  author: string | null;
  url: string | null;
};

/** L'état d'un déploiement, renvoyé sur le commit qui l'a déclenché. */
export type CommitStatus = {
  state: 'pending' | 'success' | 'failure' | 'error';
  /** Une ligne, courte : le fournisseur la tronque (140 caractères chez GitHub). */
  description: string;
  /** Distingue les cibles : `pupitre/prod-1`. */
  context: string;
  /** Lien vers le run, dans le panel. Absent si l'URL du panel est inconnue. */
  targetUrl: string | null;
};

export type SourceRepository = {
  provider: SourceProviderKind;
  fullName: string;
  installationId: number | null;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
};

export interface SourceProvider {
  readonly kind: SourceProviderKind;

  /**
   * Le dernier commit de `branch`. `etag` est celui de la réponse précédente :
   * si rien n'a bougé, le fournisseur répond « non modifié » sans décompter la
   * requête de son quota, et on rend `{ changed: false }`.
   */
  resolveHead(repo: RepositoryRef, branch: string, etag: string | null): Promise<HeadResult>;

  /** Les fichiers modifiés de `base` à `head`. */
  compare(repo: RepositoryRef, base: string, head: string): Promise<CompareResult>;

  /** Le contenu d'un fichier à un commit donné, ou `null` s'il n'existe pas. */
  readFile(repo: RepositoryRef, sha: string, path: string): Promise<string | null>;

  /**
   * Les fichiers de ce nom, partout dans l'arbre du commit — les `pupitre.json`
   * d'un dépôt, à proposer à la création d'une application. Chemins relatifs à
   * la racine, triés.
   */
  findFiles(repo: RepositoryRef, sha: string, name: string): Promise<string[]>;

  /** Le message et l'auteur d'un commit, pour le journal et l'écran. */
  commit(repo: RepositoryRef, sha: string): Promise<SourceCommit>;

  /**
   * L'archive `tar.gz` du commit, écrite dans `destination`. Une seule racine
   * dans l'archive (un dossier), que l'extraction retire. Plafonnée à
   * `maxBytes` : au-delà, l'écriture s'arrête et la méthode lève.
   */
  downloadArchive(
    repo: RepositoryRef,
    sha: string,
    destination: string,
    maxBytes: number,
  ): Promise<{ bytes: number }>;

  /** Publie l'état d'un déploiement sur le commit. */
  reportStatus(repo: RepositoryRef, sha: string, status: CommitStatus): Promise<void>;

  /** Les dépôts auxquels l'intégration a accès, pour l'écran de liaison. */
  listRepositories(): Promise<SourceRepository[]>;
}

/** Une erreur du fournisseur, avec le code HTTP quand il y en a un. */
export class SourceProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly provider: SourceProviderKind,
  ) {
    super(message);
    this.name = 'SourceProviderError';
  }
}

/** Le nom du fichier de spec par défaut, à la racine du dépôt ou du dossier de l'app. */
export const SOURCE_SPEC_FILE = 'pupitre.json';

/** Plafond d'une archive de dépôt : au-delà, le déploiement échoue en le disant. */
export const SOURCE_ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;

/** Cadence du polling : une minute entre deux questions « quoi de neuf ? ». */
export const SOURCE_POLL_EVERY_MS = 60_000;
