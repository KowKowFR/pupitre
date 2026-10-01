import { customType } from 'drizzle-orm/pg-core';

/**
 * `bytea` — Drizzle ne le fournit pas en natif ; le pilote `pg` rend déjà un
 * `Buffer` et en accepte un, il n'y a donc rien à transformer.
 *
 * ⚠ Une colonne `bytea` ne part **jamais** dans un `select *` : les écrans
 * listent des dizaines de lignes et n'ont besoin que des métadonnées. Seule la
 * route qui sert les octets les charge.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});
