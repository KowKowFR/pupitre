/**
 * Supervision de sites — le point d'entrée du vocabulaire.
 *
 * ── Pourquoi cette fonctionnalité ne double pas `health:periodic` ────────────
 * Le healthcheck périodique sonde **depuis l'intérieur** de la machine cible,
 * par SSH, via le driver : il prouve que le conteneur se répond à lui-même.
 * Une sonde de supervision part **du worker vers la cible publique**. C'est un
 * autre point de vue, et c'est toute la justification : elle voit ce que l'autre
 * ne peut pas voir — un pare-feu refermé, un proxy cassé, un certificat expiré,
 * un DNS qui ne résout plus, une latence qui dérive.
 *
 * ── L'organisation ──────────────────────────────────────────────────────────
 *   monitors/ssrf.ts     la politique SSRF, commune à tous les types
 *   monitors/catalog.ts  le catalogue déclaratif des types de sonde
 *   monitors/state.ts    verdict, machine à états, disponibilité, alerte
 *   monitors/capture.ts  les captures d'écran d'incident — vocabulaire et bornes
 *
 * Quatre fichiers, tous **purs** : ce module est importé par des composants
 * client, il ne doit tirer aucun module natif. Les sondes elles-mêmes — celles
 * qui ouvrent des connexions — vivent sous `@pupitre/core/probe`, et le pilote
 * du navigateur de capture sous `@pupitre/core/capture`.
 */

export * from './monitors/ssrf.js';
export * from './monitors/catalog.js';
export * from './monitors/state.js';
export * from './monitors/capture.js';
