import type { Translated } from '@pupitre/core';

/**
 * La coquille du panel : le rail de navigation, la barre haute, et le
 * vocabulaire des figures partagées.
 *
 * ── Pourquoi les intitulés du rail vivent ici ───────────────────────────────
 * Ce sont les douze mots les plus lus du produit, et ils nomment des
 * *sections*, pas des objets. « Supervision » mène aux serveurs relevés,
 * « Sondes » à la supervision de sites : traduits mot à mot ils auraient donné
 * deux fois *monitoring* et personne n'aurait su lequel mène où. L'anglais
 * tranche donc par la destination — **Servers** et **Monitoring** — pendant que
 * le français garde ses mots.
 *
 * ── Pourquoi le vocabulaire des figures aussi ───────────────────────────────
 * `components/chart.tsx` ne connaît aucun écran : il sait dessiner un taux, une
 * courbe, un rail d'événements. Ses phrases — « aucune mesure », « intervalles
 * mesurés sur 24 » — appartiennent donc à l'outil, pas au tableau de bord qui
 * s'en sert. Les *titres* des figures, eux, restent chez l'appelant : c'est lui
 * qui sait ce qu'il mesure.
 */
const fr = {
  // ── Rail de navigation ──────────────────────────────────────────────────
  'nav.dashboard': 'Tableau de bord',
  'nav.targets': 'Cibles',
  'nav.applications': 'Applications',
  'nav.servers': 'Supervision',
  'nav.monitoring': 'Sondes',
  'nav.deployments': 'Déploiements',
  'nav.jobs': 'Tâches',
  'nav.logs': 'Logs',
  'nav.users': 'Utilisateurs',
  'nav.roles': 'Rôles',
  'nav.settings': 'Paramètres',
  'nav.group.operations': 'Exploitation',
  'nav.group.administration': 'Administration',
  /** Le nom de la zone de navigation, pour les lecteurs d'écran. */
  'nav.landmark': 'Sections',
  'nav.account': 'Mon compte',
  'nav.signOut': 'Déconnexion',

  // ── Conteneur défilant d'un tableau ─────────────────────────────────────
  'table.scrollable': '{label} — défile horizontalement',
  /** Repli quand l'appelant n'a pas dit ce que le tableau contient. */
  'table.fallback': 'Tableau',

  // ── Bouton de démonstration de la file ──────────────────────────────────
  'ping.enqueue': 'Enfiler un ping',
  'ping.sending': 'Envoi…',
  'ping.failed': 'échec',

  // ── Figures ─────────────────────────────────────────────────────────────
  /**
   * Les résumés vocaux. Ils restent au pluriel en français quel que soit le
   * compte, comme avant : ce sont des libellés d'axe, pas des phrases.
   */
  'chart.bars.summary':
    '{label} — {covered} intervalles mesurés sur {total}, {samples} mesures au total',
  'chart.bars.empty': '{clock} — aucune mesure',
  'chart.bars.ratio': '{clock} — {hits}/{samples} {unit}',
  'chart.bars.thin': ' · trop peu de mesures pour conclure',

  'chart.series.summary': '{label} — {covered} intervalles mesurés sur {total}',
  'chart.series.void': '{clock} — aucun relevé',
  'chart.series.point': {
    one: '{clock} — {value}{unit} · {count} relevé',
    other: '{clock} — {value}{unit} · {count} relevés',
  },

  'chart.rail.summary': {
    one: '{label} — {count} événement',
    other: '{label} — {count} événements',
  },
  'chart.rail.more': '… et {count} de plus',

  'chart.axis.now': 'maintenant',

  'chart.history.title': "Pas encore assez d'historique pour une tendance.",
  'chart.history.nothing': '{nothing} sur la fenêtre.',
  'chart.history.covered': {
    one: '{count} intervalle mesuré sur {buckets}',
    other: '{count} intervalles mesurés sur {buckets}',
  },
  'chart.history.oldest': ' — le plus ancien remonte à {when}.',

  /** Deux compteurs, deux mots : une sonde prend des mesures, un balayage des relevés. */
  'chart.coverage.sample': {
    one: '{count} mesure sur {covered}/{buckets} intervalles',
    other: '{count} mesures sur {covered}/{buckets} intervalles',
  },
  'chart.coverage.readout': {
    one: '{count} relevé sur {covered}/{buckets} intervalles',
    other: '{count} relevés sur {covered}/{buckets} intervalles',
  },
  'chart.coverage.thin': '{count} sous {min} mesures',
  'chart.coverage.missing': '{count} sans relevé',

  'chart.gauge.unmeasured': 'non mesuré',
  'chart.gauge.percent': '{value} %',
} as const;

const en: Translated<typeof fr> = {
  'nav.dashboard': 'Dashboard',
  'nav.targets': 'Targets',
  'nav.applications': 'Applications',
  'nav.servers': 'Servers',
  'nav.monitoring': 'Monitoring',
  'nav.deployments': 'Deployments',
  'nav.jobs': 'Jobs',
  'nav.logs': 'Activity log',
  'nav.users': 'Users',
  'nav.roles': 'Roles',
  'nav.settings': 'Settings',
  'nav.group.operations': 'Operations',
  'nav.group.administration': 'Administration',
  'nav.landmark': 'Sections',
  'nav.account': 'Account',
  'nav.signOut': 'Sign out',

  'table.scrollable': '{label} — scrolls horizontally',
  'table.fallback': 'Table',

  'ping.enqueue': 'Queue a ping',
  'ping.sending': 'Sending…',
  'ping.failed': 'failed',

  'chart.bars.summary': '{label} — {covered} of {total} intervals measured, {samples} samples',
  'chart.bars.empty': '{clock} — no sample',
  'chart.bars.ratio': '{clock} — {hits}/{samples} {unit}',
  'chart.bars.thin': ' · too few samples to conclude',

  'chart.series.summary': '{label} — {covered} of {total} intervals measured',
  'chart.series.void': '{clock} — no readout',
  'chart.series.point': {
    one: '{clock} — {value}{unit} · {count} readout',
    other: '{clock} — {value}{unit} · {count} readouts',
  },

  'chart.rail.summary': {
    one: '{label} — {count} event',
    other: '{label} — {count} events',
  },
  'chart.rail.more': '… and {count} more',

  'chart.axis.now': 'now',

  'chart.history.title': 'Not enough history yet for a trend.',
  'chart.history.nothing': '{nothing} over the window.',
  'chart.history.covered': {
    one: '{count} of {buckets} intervals measured',
    other: '{count} of {buckets} intervals measured',
  },
  'chart.history.oldest': ' — the oldest dates back to {when}.',

  'chart.coverage.sample': {
    one: '{count} sample over {covered}/{buckets} intervals',
    other: '{count} samples over {covered}/{buckets} intervals',
  },
  'chart.coverage.readout': {
    one: '{count} readout over {covered}/{buckets} intervals',
    other: '{count} readouts over {covered}/{buckets} intervals',
  },
  'chart.coverage.thin': '{count} under {min} samples',
  'chart.coverage.missing': '{count} with no readout',

  'chart.gauge.unmeasured': 'not measured',
  'chart.gauge.percent': '{value}%',
};

export const chrome = { fr, en };
