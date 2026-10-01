import { DockerComposeDriver } from './docker/driver.js';
import { K3sDriver } from './k3s/driver.js';
import type { DeploymentDriver, RuntimeKind } from './types.js';

export * from './types.js';
export * from './probe.js';
export * from './secrets.js';
export * from './backoff.js';
export * from './retention.js';
export * from './ufw.js';
export * from './listening.js';
export * from './docker/driver.js';
export * from './docker/render.js';
export * from './docker/compose-model.js';

// Les deux rendus exposent volontairement les mêmes noms (`renderFiles`,
// `projectName`/`namespaceName`…) : ils répondent aux mêmes questions dans deux
// langages. On les publie sous un espace de noms plutôt qu'à plat, pour qu'un
// appelant ne puisse pas importer « le » renderer sans dire lequel.
export { K3sDriver } from './k3s/driver.js';
export * as k3sRender from './k3s/render.js';
export * as k3sManifests from './k3s/manifest-model.js';

/**
 * Fabrique de drivers.
 *
 * Ajouter un runtime = ajouter une classe et une entrée ici. Aucune autre
 * ligne du projet ne doit avoir à changer — c'est le critère de qualité posé
 * par CLAUDE.md.
 */
const registry: Record<RuntimeKind, () => DeploymentDriver> = {
  docker: () => new DockerComposeDriver(),
  k3s: () => new K3sDriver(),
};

export function getDriver(runtime: RuntimeKind): DeploymentDriver {
  return registry[runtime]();
}

export function availableRuntimes(): RuntimeKind[] {
  return Object.keys(registry) as RuntimeKind[];
}
export * from './workload-exec.js';
