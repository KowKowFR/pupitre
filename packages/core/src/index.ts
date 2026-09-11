export * from './crypto.js';
export * from './host-metrics.js';
export * from './monitoring.js';
export * from './naming.js';
export * from './notifications/catalog.js';
export * from './notifications/dispatch.js';
export * from './notifications/events.js';
export * from './notifications/message.js';
export * from './notifications/types.js';
export * from './permissions.js';
export * from './pipeline.js';
export * from './ports.js';
export * from './preflight.js';
export * from './queue.js';
export * from './schedule.js';
export * from './scan.js';
export * from './settings.js';
export * from './spec/index.js';
export * from './supervision.js';
export * from './workloads.js';

// Ni la couche SSH, ni les drivers, ni les scanners, ni la sonde HTTP ne sont
// réexportés ici : ils vivent sous `@tp/core/ssh`, `@tp/core/drivers`,
// `@tp/core/scanners` et `@tp/core/probe`,
// pour que `ssh2` reste hors du graphe de dépendances du panel Next.
// Seuls leurs *types* (`preflight.ts`, `ports.ts`, `scan.ts`) sont ici, parce
// que l'UI en a besoin et qu'ils n'exécutent rien.

// Les canaux de notification suivent la même règle : leurs *implémentations*
// vivent sous `@tp/core/notifications` (`nodemailer` n'a rien à faire dans le
// graphe du panel), mais leur catalogue, le message neutre, la table des
// événements et le contrat `NotificationChannel` sont ici — l'écran, les routes
// et `@tp/db` en ont besoin et rien de tout cela n'exécute quoi que ce soit.
