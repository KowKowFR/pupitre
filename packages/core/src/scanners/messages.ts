import { translator, type Translate, type Translated, type UiLanguage } from '../i18n.js';

/**
 * What the scanners say in a deployment's log — installing the tool, a scan's
 * summary — and in a scan's failure, in the instance's language (that of the SSH
 * session, `SshSession.language`).
 */
const fr = {
  'install.present': '{binary} {version} déjà présent',
  'install.noArch': "impossible de déterminer l'architecture de la cible (`uname -m`)",
  'install.noBinary': "{binary} ne publie pas de binaire pour l'architecture « {arch} »",
  'install.installing': 'installation de {binary} {version} ({arch})',
  'install.updating': 'mise à jour de {binary} vers {version} ({arch})',
  'install.failed': 'installation de {binary} impossible : {detail}',
  'install.unreachable': '{binary} reste injoignable après installation',
  'install.done': '{binary} installé — {version}',
  'run.timeout': 'délai dépassé après {seconds} s',
  'run.noOutput': 'aucune sortie (code {code}){hint}',
  'run.unreadable': 'sortie JSON illisible (code {code}) : {excerpt}',
  'report.vulnerabilities': {
    one: '{count} vulnérabilité rapportée',
    other: '{count} vulnérabilités rapportées',
  },
  'report.components': {
    one: '{count} composant inventorié',
    other: '{count} composants inventoriés',
  },
} as const;

const en: Translated<typeof fr> = {
  'install.present': '{binary} {version} already present',
  'install.noArch': 'cannot determine the target architecture (`uname -m`)',
  'install.noBinary': '{binary} publishes no binary for architecture “{arch}”',
  'install.installing': 'installing {binary} {version} ({arch})',
  'install.updating': 'updating {binary} to {version} ({arch})',
  'install.failed': 'installing {binary} failed: {detail}',
  'install.unreachable': '{binary} still unreachable after installation',
  'install.done': '{binary} installed — {version}',
  'run.timeout': 'timed out after {seconds} s',
  'run.noOutput': 'no output (code {code}){hint}',
  'run.unreadable': 'unreadable JSON output (code {code}): {excerpt}',
  'report.vulnerabilities': {
    one: '{count} vulnerability reported',
    other: '{count} vulnerabilities reported',
  },
  'report.components': {
    one: '{count} component inventoried',
    other: '{count} components inventoried',
  },
};

export const scannerCopy = { fr, en };

export type ScannerSay = Translate<typeof fr>;

export function scannerSay(language: UiLanguage): ScannerSay {
  return translator(scannerCopy, language);
}
