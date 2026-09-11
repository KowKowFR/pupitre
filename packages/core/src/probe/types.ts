import type { Cidr } from '../monitors/ssrf.js';
import type { CheckResult } from '../monitors/state.js';
import type { MonitorType } from '../monitors/catalog.js';

/**
 * **L'abstraction.** Une sonde, quel que soit ce qu'elle observe.
 *
 *     run(config) → CheckResult { outcome, latencyMs, detail, metrics }
 *
 * Même forme que `DeploymentDriver` et `Scanner` : une interface, une
 * implémentation par type, une fabrique. Ajouter un type de surveillance —
 * DNS, expiration de domaine, empreinte de contenu — c'est écrire une classe
 * ici et l'enregistrer, sans toucher à la table, au runner, aux routes ni à
 * l'écran.
 *
 * La configuration arrive en `unknown` : chaque implémentation la valide avec
 * le schéma Zod de **son** type, pris dans le catalogue. C'est ce qui permet au
 * reste du projet de manipuler des sondes sans jamais connaître leur forme.
 */
export type ProbeContext = {
  /** Plages internes autorisées. La politique SSRF s'applique à tous les types. */
  allowlist: readonly Cidr[];
};

export interface MonitorProbe {
  readonly type: MonitorType;
  /**
   * **Ne lève jamais** pour une panne de la cible : une cible morte est un
   * résultat, pas une erreur de programme. Ne lève pas non plus pour un refus
   * SSRF — c'est aussi un verdict, mais qui porte son motif dans `detail`.
   */
  run(config: unknown, ctx: ProbeContext): Promise<CheckResult>;
}
