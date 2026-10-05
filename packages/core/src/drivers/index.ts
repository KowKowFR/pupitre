import { DockerComposeDriver } from './docker/driver.js';
import { K3sDriver } from './k3s/driver.js';
import type { DeploymentDriver, RuntimeKind } from './types.js';

export * from './types.js';
export * from './probe.js';
export * from './secrets.js';
export * from './backoff.js';
export * from './release.js';
export * from './retention.js';
export * from './ufw.js';
export * from './listening.js';
export * from './docker/driver.js';
export * from './docker/render.js';
export * from './docker/compose-model.js';

// Both renders deliberately expose the same names (`renderFiles`,
// `projectName`/`namespaceName`…): they answer the same questions in two
// languages. We publish them under a namespace rather than flat, so that a
// caller cannot import "the" renderer without saying which.
export { K3sDriver } from './k3s/driver.js';
export * as k3sRender from './k3s/render.js';
export * as k3sManifests from './k3s/manifest-model.js';

/**
 * Driver factory.
 *
 * Adding a runtime = adding a class and an entry here. No other line of the
 * project must have to change — it is the quality bar set by CLAUDE.md.
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
