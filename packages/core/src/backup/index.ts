/**
 * `@pupitre/core/backup` — ce qui **exécute** : chiffrement en flux, accès aux
 * destinations. Hors de l'index principal, pour que `ssh2` et le réseau restent
 * hors du graphe du panel Next. Le vocabulaire pur (modèle, destinations) est,
 * lui, réexporté par l'index principal.
 */
export * from './model.js';
export * from './destinations.js';
export * from './format.js';
export * from './stores/index.js';
