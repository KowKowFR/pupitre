import { customType } from 'drizzle-orm/pg-core';

/**
 * `bytea` — Drizzle does not provide it natively; the `pg` driver already
 * returns a `Buffer` and accepts one, so there is nothing to transform.
 *
 * ⚠ A `bytea` column **never** goes out in a `select *`: the screens list dozens
 * of rows and only need the metadata. Only the route serving the bytes loads
 * them.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});
