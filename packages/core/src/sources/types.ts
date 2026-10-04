import { z } from 'zod';
import { invalid } from '../validation.js';

/**
 * `SourceProvider` — the fourth abstraction, next to `DeploymentDriver`,
 * `ProxyProvider` and `Scanner`.
 *
 * It answers a single question: **where an application's code comes from**
 * when it is not the operator pasting it into the panel. A hosted Git
 * repository (GitHub, GitLab, Gitea and Forgejo) carries at its root — or in the
 * application's folder, for a monorepo — a `pupitre.json`: the application's
 * AppSpec, versioned with its code.
 *
 * ── What the repository decides, and what it does not ───────────────────────
 * The repository says **what**: the AppSpec, nothing more, validated by the same
 * Zod schema as everywhere else. It never says **where** or **when** — the
 * targets, the runtime and the trigger mode live in the panel, under RBAC.
 * Otherwise, whoever can push to the branch would choose where their code runs.
 * And it carries no script: the same reason as rule 4 for the LLM.
 *
 * ── Why polling ─────────────────────────────────────────────────────────────
 * The panel is private: no webhook can reach it. The worker therefore queries
 * the provider (outgoing connections only), with an ETag that makes the
 * question "anything new?" almost free. This whole contract reads in that
 * direction: it is Pupitre that asks, never the provider that calls.
 *
 * ── Quality bar ─────────────────────────────────────────────────────────────
 * Adding a provider means adding a class that implements this contract, and the
 * line that builds it from its connection (`registry.ts`). Nothing else in the
 * worker or the panel knows its name — except the screen that connects it, by
 * nature specific to each (a GitHub App, a Gitea or GitLab token).
 */

export const SOURCE_PROVIDER_KINDS = ['github', 'gitea', 'gitlab'] as const;
export type SourceProviderKind = (typeof SOURCE_PROVIDER_KINDS)[number];

/**
 * A connection, its secrets decrypted: what the factory needs to build its
 * client (`createSourceProvider`). Not stored anywhere.
 */
export type SourceConnectionSecrets =
  | { provider: 'github'; appId: number; privateKey: string; apiUrl: string | null }
  | { provider: 'gitea'; baseUrl: string; token: string }
  | { provider: 'gitlab'; baseUrl: string; token: string };

/**
 * A repository's name, as its provider writes it: `owner/name`, or at GitLab the
 * whole path of its groups, `group/subgroup/project`. No `.` or `..` segment:
 * the name ends up in an API call's path.
 */
export const sourceRepositorySchema = z
  .string()
  .trim()
  .max(255)
  .regex(
    /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){1,19}$/,
    'dépôt attendu sous la forme propriétaire/nom',
  )
  .refine(
    (name) => name.split('/').every((segment) => !/^\.+$/.test(segment)),
    invalid('sources.repository'),
  );

/** A repository, designated as the provider designates it: `owner/name`. */
export type RepositoryRef = {
  /** `owner/name` — `group/subgroup/project` at GitLab. */
  fullName: string;
  /**
   * The installation of the GitHub App through which Pupitre has access. `null`
   * at a provider that has none: Gitea and GitLab open everything through their
   * token.
   */
  installationId: number | null;
};

/** Answer to "what is this branch's last commit?". */
export type HeadResult =
  | { changed: false }
  | {
      changed: true;
      sha: string;
      /** To send back with the next question: a 304 response costs nothing. */
      etag: string | null;
    };

/** What changed between two commits. */
export type CompareResult =
  | { kind: 'files'; files: string[] }
  /**
   * The comparison is not reliable: too many files for the list, rewritten
   * history (force-push), base commit gone. Everything is then treated as changed
   * — redeploying wrongly costs less than ignoring a real change.
   */
  | { kind: 'unknown'; reason: string };

export type SourceCommit = {
  sha: string;
  message: string;
  /** The author as the provider names them (login if known, otherwise name). */
  author: string | null;
  url: string | null;
};

/** A deployment's state, sent back on the commit that triggered it. */
export type CommitStatus = {
  state: 'pending' | 'success' | 'failure' | 'error';
  /** One short line: the provider truncates it (140 characters at GitHub). */
  description: string;
  /** Tells the targets apart: `pupitre/prod-1`. */
  context: string;
  /** Link to the run, in the panel. Absent if the panel's URL is unknown. */
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
   * The last commit of `branch`. `etag` is the previous response's: if nothing
   * moved, the provider answers "not modified" without counting the request
   * against its quota, and we return `{ changed: false }`.
   */
  resolveHead(repo: RepositoryRef, branch: string, etag: string | null): Promise<HeadResult>;

  /** The files modified from `base` to `head`. */
  compare(repo: RepositoryRef, base: string, head: string): Promise<CompareResult>;

  /** A file's content at a given commit, or `null` if it does not exist. */
  readFile(repo: RepositoryRef, sha: string, path: string): Promise<string | null>;

  /**
   * The files with this name, anywhere in the commit's tree — a repository's
   * `pupitre.json` files, to offer when creating an application. Paths relative to
   * the root, sorted.
   */
  findFiles(repo: RepositoryRef, sha: string, name: string): Promise<string[]>;

  /** A commit's message and author, for the log and the screen. */
  commit(repo: RepositoryRef, sha: string): Promise<SourceCommit>;

  /**
   * The commit's `tar.gz` archive, written to `destination`. A single root in the
   * archive (a folder), which extraction removes. Capped at `maxBytes`: beyond
   * that, writing stops and the method throws.
   */
  downloadArchive(
    repo: RepositoryRef,
    sha: string,
    destination: string,
    maxBytes: number,
  ): Promise<{ bytes: number }>;

  /** Publishes a deployment's state on the commit. */
  reportStatus(repo: RepositoryRef, sha: string, status: CommitStatus): Promise<void>;

  /** The repositories the integration has access to, for the linking screen. */
  listRepositories(): Promise<SourceRepository[]>;
}

/** A provider error, with the HTTP code when there is one. */
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

/** The default spec file name, at the root of the repository or of the app's folder. */
export const SOURCE_SPEC_FILE = 'pupitre.json';

/** A repository archive's cap: beyond it, the deployment fails and says so. */
export const SOURCE_ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;

/** Polling rate: one minute between two "anything new?" questions. */
export const SOURCE_POLL_EVERY_MS = 60_000;
