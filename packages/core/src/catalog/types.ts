import type { UiLanguage } from '../i18n.js';
import type { AppSpecInput } from '../spec/index.js';

/**
 * The catalog — ready-to-use applications, described as AppSpecs.
 *
 * A template is **not** a `compose.yml` copied from a README: it is a function
 * that returns a neutral AppSpec, validated by the same schema as those written
 * by hand or proposed by the AI. It knows neither Docker nor Kubernetes, and
 * therefore deploys on both runtimes.
 *
 * What the AppSpec cannot say, the catalog does not say either: no start
 * command, no variable interpolation, no mounted Docker socket. An image that
 * needs one (MinIO, Keycloak, Portainer…) does not get in — letting it in would
 * require a runtime-specific field.
 */

export const CATALOG_CATEGORIES = [
  'monitoring',
  'analytics',
  'content',
  'automation',
  'devtools',
  'productivity',
  'media',
  'security',
  'demo',
] as const;
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

/** What the operator chooses at install time. */
export type CatalogParams = {
  /** The application's name: its slug, and the AppSpec's `name`. */
  name: string;
  /** Public domain. Absent: the driver publishes on an allocated port of the target. */
  host: string | null;
  tls: boolean;
  /** Address of the person installing, for images that want an admin email. */
  email: string;
};

export type CatalogText = Record<UiLanguage, string>;

export type CatalogTemplate = {
  /** Stable identifier, in kebab-case — it serves as URL and default name. */
  id: string;
  /** The product's name, as its publisher writes it. */
  name: string;
  category: CatalogCategory;
  website: string;
  summary: CatalogText;
  /**
   * What must be done at first access: finish a wizard, create the first account.
   * Said before installing, not discovered afterwards.
   */
  firstRun: CatalogText;
  /**
   * Secrets the operator enters at install time: those they will need to sign in.
   * The others are generated, and a generated secret is never read back — a
   * generated administration password would be lost.
   */
  askedSecrets: readonly string[];
  /**
   * The application only works properly behind its domain (absolute links,
   * cookies, callbacks). Without it, it starts but misbehaves.
   */
  wantsHost: boolean;
  build(params: CatalogParams): AppSpecInput;
};
