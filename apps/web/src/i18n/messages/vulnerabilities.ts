import type { Translated } from '@pupitre/core';

/**
 * Le suivi des failles : ce qui est corrigeable, ce qui est accepté, et ce
 * qui bloque une application. Les identifiants de CVE, les paquets et leurs
 * versions viennent des scanners et ne se traduisent pas.
 */
const fr = {
  // ── Le réglage de l'application ─────────────────────────────────────────
  'policy.title': 'Ce qui bloque une mise en ligne',
  'policy.sub':
    "Le seuil de cette application, et s'il ne vaut que pour les failles corrigeables. S'applique aux prochains déploiements, redéploiements compris.",
  'policy.failOn': 'Seuil de blocage',
  'policy.inherit': "Comme l'instance — {value}",
  'policy.onlyFixable': 'Failles prises en compte',
  'policy.onlyFixable.true': 'Seulement les corrigeables',
  'policy.onlyFixable.false': 'Toutes, corrigeables ou non',
  'policy.effective': 'En vigueur : {failOn}, {fixable}.',
  'policy.effective.fixable.true': 'seulement sur les failles corrigeables',
  'policy.effective.fixable.false': 'sur toutes les failles',
  'policy.save': 'Enregistrer',
  'policy.readOnly': 'Votre rôle permet de lire ce réglage, pas de le changer.',
  'toast.policySaved': 'Réglage de « {app} » enregistré',

  // ── Les failles acceptées ───────────────────────────────────────────────
  'acceptances.title': 'Failles acceptées',
  'acceptances.sub': 'Lues et motivées : elles restent affichées, mais ne bloquent plus.',
  'acceptances.empty':
    "Aucune faille acceptée. On en accepte une depuis l'onglet « Sécurité » d'un déploiement.",
  'acceptances.anyPackage': 'tous les paquets',
  'acceptances.expires': "jusqu'au {date}",
  'acceptances.expired': 'échue le {date}',
  'acceptances.never': 'sans échéance',
  'acceptances.by': 'par {name}',
  'acceptances.remove': 'Retirer',
  'acceptances.confirm.title': "Retirer l'acceptation de {cve} ?",
  'acceptances.confirm.consequence':
    'La faille comptera de nouveau au prochain scan : elle peut bloquer une mise en ligne.',
  'acceptances.confirm.action': 'Retirer',
  'toast.acceptanceRemoved': 'Acceptation de {cve} retirée',

  // ── Accepter une faille, depuis un scan ─────────────────────────────────
  'accept.title': 'Accepter {cve}',
  'accept.body':
    'Elle restera affichée, mais ne bloquera plus les mises en ligne de « {app} ». La décision et son motif vont au journal.',
  'accept.scope': 'Portée',
  'accept.scope.package': 'Sur {package} seulement',
  'accept.scope.any': 'Sur tous les paquets',
  'accept.reason': 'Motif',
  'accept.reason.help': 'Pourquoi elle ne vous concerne pas, ou pas encore.',
  'accept.reason.placeholder':
    "Le service n'appelle jamais curl ; le correctif viendra avec la prochaine image.",
  'accept.expires': 'Échéance',
  'accept.expires.days': { one: '{count} jour', other: '{count} jours' },
  'accept.expires.never': 'Sans échéance',
  'accept.confirm': 'Accepter la faille',
  'accept.cancel': 'Annuler',
  'toast.accepted': '{cve} acceptée pour « {app} »',

  'accepted.badge': 'acceptée',
  'accepted.title': 'Acceptée {by} : {reason}',
  'accepted.revoke': "Retirer l'acceptation",

  // ── La liste d'un scan ──────────────────────────────────────────────────
  'view.label': 'Failles affichées',
  'view.all': 'Toutes',
  'view.fixable': 'Corrigeables',
  'view.unfixable': 'Sans correctif',
  'view.accepted': 'Acceptées',
  'run.fixable': {
    zero: 'aucune corrigeable',
    one: '{count} corrigeable',
    other: '{count} corrigeables',
  },
  'run.accepted': { one: '{count} acceptée', other: '{count} acceptées' },
  'run.onlyFixable': 'seuil sur les corrigeables',

  'error.applicationNotFound': "L'application {id} n'existe pas.",
  'error.acceptanceExists': '{cve} est déjà acceptée pour cette application.',
  'error.acceptanceNotFound': "Cette acceptation n'existe pas, ou plus.",
};

const en: Translated<typeof fr> = {
  'policy.title': 'What blocks a release',
  'policy.sub':
    'This application’s threshold, and whether it only counts fixable vulnerabilities. Applies to the next deployments, redeployments included.',
  'policy.failOn': 'Blocking threshold',
  'policy.inherit': 'Like the instance — {value}',
  'policy.onlyFixable': 'Vulnerabilities counted',
  'policy.onlyFixable.true': 'Only fixable ones',
  'policy.onlyFixable.false': 'All, fixable or not',
  'policy.effective': 'In effect: {failOn}, {fixable}.',
  'policy.effective.fixable.true': 'on fixable vulnerabilities only',
  'policy.effective.fixable.false': 'on every vulnerability',
  'policy.save': 'Save',
  'policy.readOnly': 'Your role can read this setting, not change it.',
  'toast.policySaved': 'Setting of “{app}” saved',

  'acceptances.title': 'Accepted vulnerabilities',
  'acceptances.sub': 'Read and justified: they stay listed, but no longer block.',
  'acceptances.empty':
    'No accepted vulnerability. You accept one from the “Security” tab of a deployment.',
  'acceptances.anyPackage': 'every package',
  'acceptances.expires': 'until {date}',
  'acceptances.expired': 'expired on {date}',
  'acceptances.never': 'no expiry',
  'acceptances.by': 'by {name}',
  'acceptances.remove': 'Remove',
  'acceptances.confirm.title': 'Remove the acceptance of {cve}?',
  'acceptances.confirm.consequence':
    'The vulnerability counts again at the next scan: it may block a release.',
  'acceptances.confirm.action': 'Remove',
  'toast.acceptanceRemoved': 'Acceptance of {cve} removed',

  'accept.title': 'Accept {cve}',
  'accept.body':
    'It stays listed, but no longer blocks releases of “{app}”. The decision and its reason go to the activity log.',
  'accept.scope': 'Scope',
  'accept.scope.package': 'On {package} only',
  'accept.scope.any': 'On every package',
  'accept.reason': 'Reason',
  'accept.reason.help': 'Why it does not affect you, or not yet.',
  'accept.reason.placeholder': 'The service never calls curl; the fix comes with the next image.',
  'accept.expires': 'Expiry',
  'accept.expires.days': { one: '{count} day', other: '{count} days' },
  'accept.expires.never': 'No expiry',
  'accept.confirm': 'Accept the vulnerability',
  'accept.cancel': 'Cancel',
  'toast.accepted': '{cve} accepted for “{app}”',

  'accepted.badge': 'accepted',
  'accepted.title': 'Accepted {by}: {reason}',
  'accepted.revoke': 'Remove the acceptance',

  'view.label': 'Vulnerabilities shown',
  'view.all': 'All',
  'view.fixable': 'Fixable',
  'view.unfixable': 'No fix',
  'view.accepted': 'Accepted',
  'run.fixable': { zero: 'none fixable', one: '{count} fixable', other: '{count} fixable' },
  'run.accepted': { one: '{count} accepted', other: '{count} accepted' },
  'run.onlyFixable': 'threshold on fixable ones',

  'error.applicationNotFound': 'Application {id} does not exist.',
  'error.acceptanceExists': '{cve} is already accepted for this application.',
  'error.acceptanceNotFound': 'This acceptance does not exist, or no longer does.',
};

export const vulnerabilities = { fr, en };
