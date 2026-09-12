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
 * Vue d'un secret telle que l'API a le droit de la rendre.
 *
 * Ce qu'elle dit : le nom, sa provenance, s'il est déclaré par l'AppSpec
 * courante, s'il porte une valeur, quels services le réclament, et — depuis
 * les alias — sous quels autres noms la même valeur est lue.
 * Ce qu'elle ne dit jamais : la valeur. Il n'existe aucune route qui la rende —
 * un secret se pose, se remplace, se régénère ou se supprime, il ne se lit pas.
 */
export type SecretView = {
  name: string;
  origin: 'generated' | 'provided' | null;
  /** Une valeur est enregistrée pour ce nom, ou pour celui dont il la reprend. */
  isSet: boolean;
  /** L'AppSpec courante déclare encore ce nom. */
  declared: boolean;
  /** Services de l'AppSpec qui le réclament. Vide pour un secret orphelin. */
  services: string[];
  /**
   * Nom du secret dont celui-ci reprend la valeur. `null` s'il porte la sienne.
   * Un alias n'a pas de ligne en base : il n'y a qu'une valeur, lue sous
   * plusieurs noms.
   */
  aliasOf: string | null;
  /** Autres noms qui reprennent la valeur de celui-ci. */
  readAs: string[];
  updatedAt: string | null;
};

/**
 * Croise ce que la spec déclare et ce que le magasin détient.
 *
 * Les deux ensembles se recouvrent mal, et c'est voulu : un nom présent des
 * deux côtés est le cas normal ; déclaré sans valeur ferait échouer le rendu ;
 * détenu sans être déclaré est un orphelin, conservé jusqu'à suppression
 * explicite — voir `syncApplicationSecrets()`.
 *
 * Un alias appartient à un troisième cas : déclaré, sans ligne en base, et
 * pourtant pourvu d'une valeur. L'écran doit le montrer comme tel, sans quoi il
 * apparaîtrait « à générer » et inviterait à lui en poser une — c'est-à-dire à
 * recréer la seconde valeur que l'alias existe précisément pour éviter.
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
