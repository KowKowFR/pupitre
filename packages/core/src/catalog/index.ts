import { z } from 'zod';
import { appSpecSchema, slugSchema, type AppSpec } from '../spec/index.js';
import { CATALOG_TEMPLATES } from './templates.js';
import type { CatalogParams, CatalogTemplate } from './types.js';

export * from './types.js';
export { CATALOG_TEMPLATES } from './templates.js';

export function findCatalogTemplate(id: string): CatalogTemplate | null {
  return CATALOG_TEMPLATES.find((template) => template.id === id) ?? null;
}

/** A domain name, without scheme or path: `tools.example.com`. */
const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'nom de domaine attendu, sans https:// ni chemin',
  );

/** What the install route receives, before calling the template. */
export const catalogParamsSchema = z.object({
  name: slugSchema,
  host: hostSchema.nullable().default(null),
  tls: z.boolean().default(true),
  email: z.string().trim().email().max(254),
});

/**
 * A template, rendered as a **validated** AppSpec.
 *
 * The template is trusted code, but it goes through the same schema as the rest:
 * a broken template fails here, at install time, with Zod's complaints — not at
 * deployment, on a target, three steps further.
 */
export function instantiateCatalogTemplate(
  template: CatalogTemplate,
  params: CatalogParams,
): AppSpec {
  return appSpecSchema.parse(template.build({ ...params, tls: params.host ? params.tls : false }));
}
