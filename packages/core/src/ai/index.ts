/**
 * AppSpec generation by AI.
 *
 * A dedicated subpath (`@pupitre/core/ai`) rather than a re-export from the
 * root: the SDK and its provider have no business in the dependency graph of the
 * worker, which generates nothing. The same rule as `@pupitre/core/ssh`,
 * `/drivers` and `/scanners`.
 */
export * from './assets.js';
export * from './catalog.js';
export * from './providers.js';
export * from './prompt.js';
export * from './model.js';
export * from './generate.js';
