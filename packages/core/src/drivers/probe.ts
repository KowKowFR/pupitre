import type { AppSpec, Service } from '../spec/index.js';

/**
 * Probe rule, shared by both drivers.
 *
 * `healthcheckSchema` imposes a `path` with a `'/'` default: an AppSpec
 * therefore **always** carries a path, including for a database that does not
 * speak HTTP. Deciding whether that path means anything is not a runtime matter
 * — it is a reading of the spec — and both drivers must draw the same
 * conclusion from it, otherwise the same AppSpec deploys on one side and fails
 * on the other. Hence this shared module rather than a function copied into each
 * render.
 */

/**
 * A service is probed over HTTP if it is the entry point — exposed service, or
 * the ingress's target. The others are probed at the TCP level: not all of them
 * speak HTTP, and the spec does not have to know.
 */
export function isHttpProbed(spec: AppSpec, service: Service): boolean {
  return service.exposed || spec.ingress?.targetService === service.name;
}

/** Probed port: the one the healthcheck designates, otherwise the service's. */
export function probePort(service: Service): number {
  return service.healthcheck.port ?? service.port;
}
