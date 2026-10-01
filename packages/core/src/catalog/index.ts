import { z } from 'zod';
import { appSpecSchema, slugSchema, type AppSpec } from '../spec/index.js';
import { CATALOG_TEMPLATES } from './templates.js';
import type { CatalogParams, CatalogTemplate } from './types.js';

export * from './types.js';
export { CATALOG_TEMPLATES } from './templates.js';

export function findCatalogTemplate(id: string): CatalogTemplate | null {
  return CATALOG_TEMPLATES.find((template) => template.id === id) ?? null;
}

/** Un nom de domaine, sans schéma ni chemin : `outils.atelier-nord.fr`. */
const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'nom de domaine attendu, sans https:// ni chemin',
  );

/** Ce que la route d'installation reçoit, avant d'appeler le modèle. */
export const catalogParamsSchema = z.object({
  name: slugSchema,
  host: hostSchema.nullable().default(null),
  tls: z.boolean().default(true),
  email: z.string().trim().email().max(254),
});

/**
 * Un modèle, rendu en AppSpec **validée**.
 *
 * Le modèle est du code de confiance, mais il passe par le même schéma que le
 * reste : un modèle cassé échoue ici, à l'installation, avec les reproches de
 * Zod — pas au déploiement, sur une cible, trois étapes plus loin.
 */
export function instantiateCatalogTemplate(
  template: CatalogTemplate,
  params: CatalogParams,
): AppSpec {
  return appSpecSchema.parse(template.build({ ...params, tls: params.host ? params.tls : false }));
}
