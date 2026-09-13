/**
 * La capture d'écran d'incident — la partie qui ouvre des connexions.
 *
 * Point d'entrée distinct de `@pupitre/core` parce qu'il tire `node:net`,
 * `node:http` et `node:dns` : le vocabulaire de la capture (types, bornes,
 * arbitrages) vit dans `monitors/capture.ts`, qui est pur et que les composants
 * client peuvent importer. Même découpage que `monitors/` et `probe/`.
 *
 *   captureUrl()            pilote le navigateur distant en CDP et rend l'image
 *   createCaptureEgress()   le mandataire par lequel ce navigateur sort
 */
export * from './cdp.js';
export * from './egress.js';
