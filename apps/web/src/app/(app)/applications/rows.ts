import type { AppSpec } from '@pupitre/core';
import type { ApplicationRow, ServiceRow } from './applications-view';

/**
 * The AppSpec read again for display — list, drawer and record read the same
 * one. An old spec may not carry the schema's default values: they are assumed
 * here rather than letting a screen fall on an `undefined`.
 */
export function serviceRows(spec: AppSpec): ServiceRow[] {
  return spec.services.map((service) => ({
    name: service.name,
    port: service.port,
    exposed: service.exposed,
    replicas: service.replicas ?? 1,
    health: service.healthcheck
      ? {
          path: service.healthcheck.path,
          interval: service.healthcheck.intervalSec,
          retries: service.healthcheck.retries,
        }
      : null,
    dependsOn: service.dependsOn ?? [],
    volumes: (service.volumes ?? []).map((volume) => volume.name),
    secrets: (service.secrets ?? []).map((secret) => (typeof secret === 'string' ? secret : secret.name)),
  }));
}

export function ingressOf(spec: AppSpec): ApplicationRow['ingress'] {
  return spec.ingress
    ? { host: spec.ingress.host ?? null, service: spec.ingress.targetService, tls: spec.ingress.tls }
    : null;
}
