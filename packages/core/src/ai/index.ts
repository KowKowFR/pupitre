/**
 * Génération d'AppSpec par IA.
 *
 * Sous-chemin dédié (`@tp/core/ai`) plutôt que réexport depuis la racine : le
 * SDK et son provider n'ont rien à faire dans le graphe de dépendances du
 * worker, qui ne génère rien. Même règle que `@tp/core/ssh`, `/drivers` et
 * `/scanners`.
 */
export * from './assets.js';
export * from './prompt.js';
export * from './model.js';
export * from './generate.js';
