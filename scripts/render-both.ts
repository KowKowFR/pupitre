/**
 * Renders an AppSpec to BOTH runtimes, without deploying anything.
 *
 *   pnpm tsx scripts/render-both.ts spec.json
 *   cat spec.json | pnpm tsx scripts/render-both.ts -
 *
 * What it is for: the project's central promise is that the SAME AppSpec deploys
 * on Docker as on K3s. The real deployment on both sides is the job of
 * `pnpm test:parity`, which requires two reachable targets. This script does not
 * claim to replace it: it checks, without any machine, that the spec goes
 * through both renderings without any field having to change.
 *
 * It is the point of the neutral AppSpec: if a rendering ever asks for
 * information the other ignores, this script fails here, before the deployment.
 *
 * Output: a summary JSON on stdout, code 1 at the first problem.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { parseAppSpec, exposedService, secretNamesOf } from '@pupitre/core';
// `@pupitre/core/drivers` pulls in `ssh2`: acceptable for a Node script, never for
// the panel — it is why this subpath exists.
import {
  renderComposeFile,
  serializeComposeFile,
  k3sRender,
} from '@pupitre/core/drivers';

function fail(message: string): never {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

function main(): void {
  const source = process.argv[2];
  if (!source) fail('usage: tsx scripts/render-both.ts <spec.json|->');

  const raw = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`unreadable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const spec = parseAppSpec(parsed);
  const appSlug = spec.name;

  /**
   * Filler values for the declared secrets.
   *
   * This tool compares **two renderings**: it has neither an application in the
   * database nor a secrets store. Yet both renderings now refuse a secret
   * declared without a value — rightly, it is what keeps an empty `.env` from
   * leaving for a machine. Here the value does not matter at all: what we check
   * is that the same AppSpec produces a consistent compose AND manifests, not
   * that the secret is the right one. The same value is given to both sides,
   * which makes the comparison more straightforward, by the way.
   */
  const secretValues = Object.fromEntries(
    secretNamesOf(spec).map((name) => [name, `render-value-${name.toLowerCase()}`]),
  );

  // ─── Docker ────────────────────────────────────────────────────────────────
  const compose = serializeComposeFile(
    renderComposeFile({ spec, appSlug, publishedPort: 30_000, language: 'en' }),
  );
  const composeDoc: unknown = parseYaml(compose);
  if (typeof composeDoc !== 'object' || composeDoc === null || !('services' in composeDoc)) {
    fail('the Compose rendering produces no `services` block');
  }
  const composeServices = Object.keys(
    (composeDoc as { services: Record<string, unknown> }).services,
  );
  if (composeServices.length !== spec.services.length) {
    fail(
      `Compose: ${composeServices.length} service(s) rendered for ${spec.services.length} declared`,
    );
  }

  // ─── K3s ───────────────────────────────────────────────────────────────────
  const manifests = k3sRender.renderManifests({ spec, appSlug, secretValues, language: 'en' });
  const kinds: Record<string, number> = {};
  for (const manifest of manifests) {
    kinds[manifest.kind] = (kinds[manifest.kind] ?? 0) + 1;

    // Each manifest must be YAML that reads back, with the fields the API server
    // requires. A rendering that does not go back through its own parser has
    // proven nothing.
    const yaml = k3sRender.serializeManifest(manifest);
    const back: unknown = parseYaml(yaml);
    if (typeof back !== 'object' || back === null) {
      fail(`manifest ${manifest.kind}: YAML does not read back`);
    }
    const document = back as { apiVersion?: unknown; kind?: unknown; metadata?: unknown };
    if (typeof document.apiVersion !== 'string' || typeof document.kind !== 'string') {
      fail(`manifest ${manifest.kind}: apiVersion or kind missing after reading back`);
    }
    if (typeof document.metadata !== 'object' || document.metadata === null) {
      fail(`manifest ${manifest.kind}: metadata missing after reading back`);
    }
  }

  if ((kinds.Deployment ?? 0) !== spec.services.length) {
    fail(`K3s: ${kinds.Deployment ?? 0} Deployment(s) for ${spec.services.length} service(s)`);
  }
  if ((kinds.Namespace ?? 0) !== 1) fail('K3s: the Namespace is missing');
  if ((kinds.Service ?? 0) !== spec.services.length) {
    fail(`K3s: ${kinds.Service ?? 0} Service(s) for ${spec.services.length} declared`);
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
