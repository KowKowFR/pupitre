import type { AppSpec } from '@pupitre/core';
import type { ApplicationRow, ServiceRow } from './applications-view';

/**
 * L'AppSpec relue pour l'affichage — liste, drawer et fiche lisent la même.
 * Une spec ancienne peut ne pas porter les valeurs par défaut du schéma : on
 * les suppose ici plutôt que de laisser un écran tomber sur un `undefined`.
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
