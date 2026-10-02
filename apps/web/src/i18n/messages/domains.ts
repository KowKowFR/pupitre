import type { Translated } from '@pupitre/core';

/**
 * La page « Domaines » : tous les noms par lesquels on atteint les
 * applications de l'instance. Les états d'une route et de son certificat
 * viennent du vocabulaire du proxy (`proxy.ts`), partagé avec la fiche d'une
 * application.
 */
const fr = {
  'meta.title': 'Domaines',
  'page.title': 'Domaines',
  'page.description':
    'Tous les noms par lesquels on atteint vos applications : le proxy qui les sert, leur état, et l’échéance de leur certificat.',
  'filter.label': 'Filtrer les domaines',
  'filter.all': 'Tous · {count}',
  'filter.attention': 'À surveiller · {count}',
  'column.domain': 'Domaine',
  'column.application': 'Application',
  'column.machine': 'Machine',
  'column.proxy': 'Proxy',
  'column.status': 'État',
  'column.certificate': 'Certificat',
  'column.checked': 'Dernière sonde',
  'proxy.none': 'aucun proxy',
  'proxy.via': 'par {target}',
  'cert.http': 'HTTP seul',
  'cert.until': 'jusqu’au {date}',
  'cert.daysLeft': { one: 'dans {count} jour', other: 'dans {count} jours' },
  'cert.today': 'échoit aujourd’hui',
  'cert.expiredToday': 'échu aujourd’hui',
  'cert.expired': { one: 'échu depuis {count} jour', other: 'échu depuis {count} jours' },
  'checked.never': 'jamais',
  'empty.title': 'Aucun domaine',
  'empty.hint':
    'Un domaine se pose sur la fiche d’une application, ou à son déploiement, quand sa machine a un reverse proxy.',
  'empty.action': 'Voir les applications',
  'empty.attention.title': 'Rien à surveiller',
  'empty.attention.hint':
    'Tous les domaines répondent, et aucun certificat n’approche de son échéance.',
};

const en: Translated<typeof fr> = {
  'meta.title': 'Domains',
  'page.title': 'Domains',
  'page.description':
    'Every name your applications are reached by: the proxy serving it, its state, and when its certificate expires.',
  'filter.label': 'Filter domains',
  'filter.all': 'All · {count}',
  'filter.attention': 'To watch · {count}',
  'column.domain': 'Domain',
  'column.application': 'Application',
  'column.machine': 'Machine',
  'column.proxy': 'Proxy',
  'column.status': 'State',
  'column.certificate': 'Certificate',
  'column.checked': 'Last probe',
  'proxy.none': 'no proxy',
  'proxy.via': 'through {target}',
  'cert.http': 'HTTP only',
  'cert.until': 'until {date}',
  'cert.daysLeft': { one: 'in {count} day', other: 'in {count} days' },
  'cert.today': 'expires today',
  'cert.expiredToday': 'expired today',
  'cert.expired': { one: 'expired {count} day ago', other: 'expired {count} days ago' },
  'checked.never': 'never',
  'empty.title': 'No domain',
  'empty.hint':
    'A domain is set on an application’s page, or when deploying it, once its machine has a reverse proxy.',
  'empty.action': 'See applications',
  'empty.attention.title': 'Nothing to watch',
  'empty.attention.hint': 'Every domain answers, and no certificate is close to expiring.',
};

export const domains = { fr, en };
