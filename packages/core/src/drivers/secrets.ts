import {
  secretBindings,
  secretNamesOf,
  secretRootName,
  storedSecretNames,
  type AppSpec,
} from '../spec/index.js';
import type { UiLanguage } from '../i18n.js';
import { driverSay } from './messages.js';

/**
 * Resolving secret values, at render time.
 *
 * The AppSpec only declares **names**: the values live encrypted in the database
 * and are provided by the caller through `DriverContext.resolveSecrets`. This
 * module is the only place where we decide what happens when a value is
 * missing, and it is shared by both renders so that they cannot diverge.
 *
 * ── Aliases are resolved here, not in a driver ──────────────────────────────
 *
 * A secret can declare that it reuses another's value (`{ name, from }`) — it is
 * what lets `mariadb:11` and `wordpress` share a password they read under two
 * different names. The alias chain is followed **here**, in the neutral code,
 * and both drivers receive an already complete map, where each declared name has
 * its value. Compose could have interpolated `${MARIADB_PASSWORD}` from the
 * `.env`; Kubernetes interpolates nothing. Resolving before the render is the
 * only way for the same AppSpec to work on both sides.
 */

/** A secret declared by the spec for which the caller provided no value. */
export class UnresolvedSecretError extends Error {
  override readonly name = 'UnresolvedSecretError';

  constructor(
    readonly names: readonly string[],
    language: UiLanguage,
  ) {
    super(driverSay(language)('secrets.unresolved', { names: names.join(', ') }));
  }
}

/** Names of the secrets declared by the spec, aliases included, deduplicated. */
export function declaredSecretNames(spec: AppSpec): string[] {
  return secretNamesOf(spec);
}

/**
 * Names for which the caller must provide a value.
 *
 * The roots only: an alias has no value of its own, so it has nothing to ask the
 * store for — and above all nothing to create there. It is this list the drivers
 * pass to `resolveSecrets`.
 */
export { storedSecretNames };

/**
 * Completes the table of values for every declared secret, and **fails** if one
 * of them was not resolved.
 *
 * Input: the values of the **roots**, as the store returns them.
 * Output: one value per **declared** name, aliases included — two names linked
 * by an alias therefore carry, literally, the same string.
 *
 * The test is on the *presence of the key*, never on the value: a deliberately
 * empty secret stays legitimate — some images tell "variable absent" from
 * "variable empty" — whereas a secret absent from the table means nobody could
 * answer. Writing `''` in both cases, as the Docker render did, turned a
 * nameable error into an obscure failure three steps further: PostgreSQL
 * refusing to initialize, then the application service's
 * `depends_on: service_healthy` blocking forever.
 */
export function completeSecretValues(
  spec: AppSpec,
  values: Readonly<Record<string, string>> = {},
  language: UiLanguage,
): Record<string, string> {
  const bindings = secretBindings(spec);
  const complete: Record<string, string> = {};
  const missing = new Set<string>();

  for (const name of declaredSecretNames(spec)) {
    // The name that really carries the value — itself, except for an alias.
    const root = secretRootName(bindings, name);
    if (Object.hasOwn(values, root)) {
      complete[name] = values[root] as string;
    } else {
      // We name the root: it is the one to fill in, not the alias.
      missing.add(root);
    }
  }

  if (missing.size > 0) throw new UnresolvedSecretError([...missing], language);
  return complete;
}
