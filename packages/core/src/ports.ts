/**
 * Réservation de ports publics sur une cible.
 *
 * L'interface vit ici, à la racine de `@pupitre/core`, et non dans `drivers/` :
 * son implémentation est en base (`packages/db`), qui n'a aucune raison de
 * tirer `ssh2` dans son graphe de types.
 *
 * L'anti-collision est une contrainte unique `(target_id, port)`, jamais un
 * `if` en TypeScript. Le driver demande, la base tranche.
 */

export const PORT_RANGE_MIN = 30_000;
export const PORT_RANGE_MAX = 32_767;

export type PortAllocationRequest = {
  targetId: string;
  applicationId: string;
  min: number;
  max: number;
  /**
   * Ports à écarter du tirage, en plus de ceux déjà réservés en base.
   *
   * Sert au constat fait sur la cible : un port peut être occupé par un service
   * qui n'appartient pas au panel, et la base n'en sait rien. L'appelant relance
   * alors `allocate()` en excluant ce qu'il vient de voir occupé.
   */
  exclude?: readonly number[];
};

export type PortAllocationKey = {
  targetId: string;
  applicationId: string;
};

export type PortAllocator = {
  /**
   * Réserve un port libre dans `[min, max]`. Rejoue sur conflit d'unicité.
   * Retourne le port déjà réservé si l'application en a un.
   */
  allocate: (request: PortAllocationRequest) => Promise<number>;
  /** Libère la réservation. Idempotent. */
  release: (key: PortAllocationKey) => Promise<void>;
  /** Port déjà réservé, ou `null`. */
  current: (key: PortAllocationKey) => Promise<number | null>;
};

/** Plage de ports publiables, telle que la porte une cible. */
export type PortRange = { min: number; max: number };

export const DEFAULT_PORT_RANGE: PortRange = { min: PORT_RANGE_MIN, max: PORT_RANGE_MAX };

/**
 * Intersection de deux plages.
 *
 * Une cible déclare la sienne (`targets.port_range_start/end`) ; le worker peut
 * en imposer une plus étroite globalement (`DRIVER_PORT_RANGE`), typiquement
 * quand c'est l'hôte qui n'en publie qu'une partie. Les deux contraintes sont
 * réelles : on garde leur intersection, pas la dernière lue.
 * Retourne `null` si elles ne se recouvrent pas — un cas à signaler, pas à taire.
 */
export function intersectPortRanges(a: PortRange, b: PortRange | undefined): PortRange | null {
  if (!b) return a;
  const min = Math.max(a.min, b.min);
  const max = Math.min(a.max, b.max);
  return min <= max ? { min, max } : null;
}

/** Nombre de ports d'une plage, bornes comprises. */
export function portRangeSize(range: PortRange): number {
  return Math.max(0, range.max - range.min + 1);
}

/** Aucun port libre dans la plage demandée. */
export class PortExhaustedError extends Error {
  constructor(
    readonly targetId: string,
    readonly min: number,
    readonly max: number,
  ) {
    super(`Aucun port libre entre ${min} et ${max} sur la cible ${targetId}`);
    this.name = 'PortExhaustedError';
  }
}
