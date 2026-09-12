/**
 * Génération d'AppSpec par IA.
 *
 * Sous-chemin dédié (`@pupitre/core/ai`) plutôt que réexport depuis la racine : le
 * SDK et son provider n'ont rien à faire dans le graphe de dépendances du
 * worker, qui ne génère rien. Même règle que `@pupitre/core/ssh`, `/drivers` et
 * `/scanners`.
 */
export * from './assets.js';
export * from './catalog.js';
export * from './providers.js';
export * from './prompt.js';
export * from './model.js';
export * from './generate.js';
