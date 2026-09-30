export * from './crypto.js';
export * from './host-metrics.js';
export * from './i18n.js';
export * from './monitoring.js';
export * from './naming.js';
export * from './notifications/account-mail.js';
export * from './notifications/catalog.js';
export * from './notifications/digest.js';
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
export * from './sources/types.js';
export * from './sources/spec-change.js';
export * from './sources/spec-file.js';
export * from './sources/watch.js';
export * from './spec/index.js';
export * from './supervision.js';
export * from './workloads.js';

// Ni la couche SSH, ni les drivers, ni les scanners, ni la sonde HTTP ne sont
// réexportés ici : ils vivent sous `@pupitre/core/ssh`, `@pupitre/core/drivers`,
// `@pupitre/core/scanners` et `@pupitre/core/probe`,
// pour que `ssh2` reste hors du graphe de dépendances du panel Next.
// Seuls leurs *types* (`preflight.ts`, `ports.ts`, `scan.ts`) sont ici, parce
// que l'UI en a besoin et qu'ils n'exécutent rien.

// Les canaux de notification suivent la même règle : leurs *implémentations*
// vivent sous `@pupitre/core/notifications` (`nodemailer` n'a rien à faire dans le
// graphe du panel), mais leur catalogue, le message neutre, la table des
// événements et le contrat `NotificationChannel` sont ici — l'écran, les routes
// et `@pupitre/db` en ont besoin et rien de tout cela n'exécute quoi que ce soit.
