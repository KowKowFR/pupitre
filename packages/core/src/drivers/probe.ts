import type { AppSpec, Service } from '../spec/index.js';

/**
 * Règle de sonde, commune aux deux drivers.
 *
 * `healthcheckSchema` impose un `path` avec un défaut `'/'` : une AppSpec porte
 * donc **toujours** un chemin, y compris pour une base de données qui ne parle
 * pas HTTP. Décider si ce chemin veut dire quelque chose n'est pas une affaire
 * de runtime — c'est une lecture de la spec — et les deux drivers doivent en
 * tirer la même conclusion, sinon la même AppSpec se déploie d'un côté et
 * échoue de l'autre. D'où ce module partagé plutôt qu'une fonction recopiée
 * dans chaque rendu.
 */

/**
 * Un service est sondé en HTTP s'il est la porte d'entrée — service exposé, ou
 * cible de l'ingress. Les autres sont sondés au niveau TCP : tous ne parlent
 * pas HTTP, et la spec n'a pas à le savoir.
 */
export function isHttpProbed(spec: AppSpec, service: Service): boolean {
  return service.exposed || spec.ingress?.targetService === service.name;
}

/** Port sondé : celui que le healthcheck désigne, à défaut celui du service. */
export function probePort(service: Service): number {
  return service.healthcheck.port ?? service.port;
}
