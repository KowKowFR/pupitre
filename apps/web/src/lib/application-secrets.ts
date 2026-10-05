import 'server-only';
import {
  secretBindings,
  secretDeclarationName,
  secretNamesOf,
  secretRootName,
  type AppSpec,
} from '@pupitre/core';
import { type PublicApplicationSecret } from '@pupitre/db';

/**
 * A secret's view as the API is allowed to return it.
 *
 * What it says: the name, its provenance, whether the current AppSpec declares
 * it, whether it carries a value, which services require it, and — since the
 * aliases — under which other names the same value is read. What it never says:
 * the value. No route returns it — a secret is set, replaced, regenerated or
 * deleted, it is not read.
 */
export type SecretView = {
  name: string;
  origin: 'generated' | 'provided' | null;
  /** A value is saved for this name, or for the one it takes the value from. */
  isSet: boolean;
  /** The current AppSpec still declares this name. */
  declared: boolean;
  /** The AppSpec's services that require it. Empty for an orphan secret. */
  services: string[];
  /**
   * The name of the secret this one takes the value from. `null` if it carries its
   * own. An alias has no database row: there is only one value, read under several
   * names.
   */
  aliasOf: string | null;
  /** Other names that take this one's value. */
  readAs: string[];
  updatedAt: string | null;
};

/**
 * Crosses what the spec declares and what the store holds.
 *
 * The two sets overlap badly, and it is on purpose: a name present on both sides
 * is the normal case; declared without a value would fail the rendering; held
 * without being declared is an orphan, kept until explicitly deleted — see
 * `syncApplicationSecrets()`.
 *
 * An alias belongs to a third case: declared, without a database row, and yet
 * given a value. The screen must show it as such, otherwise it would appear "to
 * generate" and would invite setting one on it — that is, recreating the second
 * value the alias exists precisely to avoid.
 */
export function buildSecretViews(
  spec: AppSpec,
  stored: PublicApplicationSecret[],
): SecretView[] {
  const bindings = secretBindings(spec);
  const declared = secretNamesOf(spec);
  const byName = new Map(stored.map((row) => [row.name, row]));
  const names = [...new Set([...declared, ...stored.map((row) => row.name)])].sort();

  return names.map((name) => {
    const root = secretRootName(bindings, name);
    const aliasOf = root === name ? null : root;
    const source = byName.get(root);

    return {
      name,
      origin: aliasOf ? null : (byName.get(name)?.origin ?? null),
      isSet: byName.has(root),
      declared: declared.includes(name),
      services: spec.services
        .filter((service) => service.secrets.some((s) => secretDeclarationName(s) === name))
        .map((service) => service.name),
      aliasOf,
      readAs: declared.filter((other) => other !== name && secretRootName(bindings, other) === name),
      updatedAt: source?.updatedAt.toISOString() ?? null,
    };
  });
}
