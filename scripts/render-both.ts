/**
 * Rend une AppSpec vers les DEUX runtimes, sans rien déployer.
 *
 *   pnpm tsx scripts/render-both.ts spec.json
 *   cat spec.json | pnpm tsx scripts/render-both.ts -
 *
 * À quoi ça sert : le critère de sortie n° 2 du jalon 8 demande que la MÊME
 * AppSpec générée se déploie aussi sur K3s. Ce n'est **pas** vérifiable
 * aujourd'hui — aucun cluster K3s n'est enregistré, et `test-parity.ts` n'a
 * jamais tourné de bout en bout. Ce script ne prétend pas le remplacer : il
 * vérifie ce qui *est* vérifiable sans cluster, à savoir que la spec produite
 * par le modèle traverse les deux rendus sans qu'aucun champ n'ait à changer.
 *
 * C'est le point de l'AppSpec neutre : si un jour un rendu réclame une
 * information que l'autre ignore, ce script échoue ici, avant le déploiement.
 *
 * Sortie : un JSON de résumé sur stdout, code 1 au premier problème.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { parseAppSpec, exposedService, secretNamesOf } from '@tp/core';
// `@tp/core/drivers` tire `ssh2` : acceptable pour un script Node, jamais pour
// le panel — c'est pourquoi ce sous-chemin existe.
import {
  renderComposeFile,
  serializeComposeFile,
  k3sRender,
} from '@tp/core/drivers';

function fail(message: string): never {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

function main(): void {
  const source = process.argv[2];
  if (!source) fail('usage : tsx scripts/render-both.ts <spec.json|->');

  const raw = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`JSON illisible : ${error instanceof Error ? error.message : String(error)}`);
  }

  const spec = parseAppSpec(parsed);
  const appSlug = spec.name;

  /**
   * Valeurs de remplissage pour les secrets déclarés.
   *
   * Cet outil compare **deux rendus** : il n'a ni application en base, ni
   * magasin de secrets. Or les deux rendus refusent désormais un secret
   * déclaré sans valeur — à raison, c'est ce qui empêche un `.env` vide de
   * partir sur une machine. Ici la valeur n'a aucune importance : ce qu'on
   * vérifie, c'est que la même AppSpec produit un compose ET des manifests
   * cohérents, pas que le secret soit le bon. La même valeur est donnée aux
   * deux côtés, ce qui rend d'ailleurs la comparaison plus franche.
   */
  const secretValues = Object.fromEntries(
    secretNamesOf(spec).map((name) => [name, `valeur-de-rendu-${name.toLowerCase()}`]),
  );

  // ─── Docker ────────────────────────────────────────────────────────────────
  const compose = serializeComposeFile(
    renderComposeFile({ spec, appSlug, publishedPort: 30_000 }),
  );
  const composeDoc: unknown = parseYaml(compose);
  if (typeof composeDoc !== 'object' || composeDoc === null || !('services' in composeDoc)) {
    fail('le rendu Compose ne produit pas de bloc `services`');
  }
  const composeServices = Object.keys(
    (composeDoc as { services: Record<string, unknown> }).services,
  );
  if (composeServices.length !== spec.services.length) {
    fail(
      `Compose : ${composeServices.length} service(s) rendu(s) pour ${spec.services.length} déclaré(s)`,
    );
  }

  // ─── K3s ───────────────────────────────────────────────────────────────────
  const manifests = k3sRender.renderManifests({ spec, appSlug, secretValues });
  const kinds: Record<string, number> = {};
  for (const manifest of manifests) {
    kinds[manifest.kind] = (kinds[manifest.kind] ?? 0) + 1;

    // Chaque manifest doit être du YAML relisible, avec les champs que l'API
    // server exige. Un rendu qui ne repasse pas par son propre analyseur n'a
    // rien prouvé.
    const yaml = k3sRender.serializeManifest(manifest);
    const back: unknown = parseYaml(yaml);
    if (typeof back !== 'object' || back === null) {
      fail(`manifest ${manifest.kind} : YAML non relisible`);
    }
    const document = back as { apiVersion?: unknown; kind?: unknown; metadata?: unknown };
    if (typeof document.apiVersion !== 'string' || typeof document.kind !== 'string') {
      fail(`manifest ${manifest.kind} : apiVersion ou kind manquant après relecture`);
    }
    if (typeof document.metadata !== 'object' || document.metadata === null) {
      fail(`manifest ${manifest.kind} : metadata manquant après relecture`);
    }
  }

  if ((kinds.Deployment ?? 0) !== spec.services.length) {
    fail(`K3s : ${kinds.Deployment ?? 0} Deployment(s) pour ${spec.services.length} service(s)`);
  }
  if ((kinds.Namespace ?? 0) !== 1) fail('K3s : le Namespace manque');
  if ((kinds.Service ?? 0) !== spec.services.length) {
    fail(`K3s : ${kinds.Service ?? 0} Service(s) pour ${spec.services.length} déclaré(s)`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        name: spec.name,
        version: spec.version,
        services: spec.services.map((service) => service.name),
        exposed: exposedService(spec).name,
        docker: { services: composeServices, bytes: compose.length },
        k3s: { namespace: k3sRender.namespaceName(appSlug), manifests: manifests.length, kinds },
      },
      null,
      2,
    )}\n`,
  );
}

main();
