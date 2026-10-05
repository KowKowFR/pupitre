import { translator, type Translate, type Translated, type UiLanguage } from '../i18n.js';

/**
 * What the SSH layer says — connection errors, a target's preflight, reading its
 * metrics —, in the instance's language. The session keeps it
 * (`SshSession.language`): a command that exceeds its timeout says so in the
 * language of whoever opened it.
 */
const fr = {
  'auth.refused':
    'Authentification SSH refusée (clé ou mot de passe invalide, ou passphrase manquante)',
  'auth.refused.short': 'Authentification refusée (clé, mot de passe ou passphrase invalide)',
  'connect.failed': 'Connexion SSH impossible vers {host}:{port} après {retries} tentatives',
  'hostKey.changed':
    'La clé d’hôte de {host} a changé : attendue {expected}, présentée {presented}. Si la machine a été réinstallée, acceptez la nouvelle clé sur la page de la cible ; sinon, une autre machine se fait peut-être passer pour elle — connexion refusée.',
  'sudo.passwordWithKey':
    'sudo_method « password » exige une authentification par mot de passe : aucun mot de passe disponible pour cette cible en authentification par clé',
  'command.interrupted': 'Commande interrompue après {ms} ms',
  'command.timedOut': 'timeout après {ms} ms',
  'session.closed': 'Session SSH fermée',
  unreadable: 'sortie illisible',

  'check.ssh': 'Connexion SSH',
  'check.ssh.detail': '{latency} ms',
  'check.ssh.key': '{latency} ms · clé {key}',
  'check.os': 'Système d’exploitation',
  'check.sudo': 'Élévation de privilèges',
  'check.sudo.nopasswd': 'sudo sans mot de passe',
  'check.sudo.password': 'sudo présent, mot de passe requis',
  'check.sudo.absent': 'sudo absent',
  'check.tools': 'Outils présents',
  'check.tools.none': 'aucun',
  'check.firewall': 'Pare-feu',
  'check.firewall.absent': 'ufw absent',
  'check.firewall.active': {
    one: 'ufw actif — {count} règle du panel',
    other: 'ufw actif — {count} règles du panel',
  },
  'check.firewall.inactive': 'ufw installé mais inactif',
  'check.docker.noBinary': 'binaire absent',
  'check.docker.daemon': 'daemon injoignable : {detail}',
  'check.k3s.noKubectl': 'kubectl absent',
  'check.k3s.noCluster': 'kubectl présent mais aucun cluster joignable',
  'check.k3s.nodes': '{ready}/{total} node(s) prêt(s){version}',
  'check.disk': 'Espace disque',
  'check.disk.free': '{gib} Gio libres ({percent} % utilisés)',
  'check.disk.unreadable': 'sortie de df illisible',
  'check.memory': 'Mémoire',
  'check.memory.available': '{available} Mio disponibles sur {total}',
  'check.memory.unavailable': 'free indisponible',

  'metrics.load': 'Charge moyenne',
  'metrics.cores': 'Cœurs',
  'metrics.cores.count': { one: '{count} cœur', other: '{count} cœurs' },
  'metrics.memory.available': '{available} disponibles sur {total}',
  'metrics.memory.missing': 'MemTotal ou MemAvailable absent',
  'metrics.disk.free': '{path} — {available} libres ({percent} % utilisés)',
  'metrics.uptime.days': { one: '{count} jour', other: '{count} jours' },
  'metrics.os': 'Système',
  'metrics.unavailable': '{tool} indisponible : {detail}',
  'metrics.unreadableFile': '{file} illisible',
  gib: '{value} Gio',
} as const;

const en: Translated<typeof fr> = {
  'auth.refused': 'SSH authentication refused (invalid key or password, or missing passphrase)',
  'auth.refused.short': 'Authentication refused (invalid key, password or passphrase)',
  'connect.failed': 'Could not open an SSH connection to {host}:{port} after {retries} attempts',
  'hostKey.changed':
    'The host key of {host} has changed: expected {expected}, presented {presented}. If the machine was reinstalled, accept the new key on the target page; otherwise another machine may be impersonating it — connection refused.',
  'sudo.passwordWithKey':
    'sudo_method “password” requires password authentication: this target uses key authentication, so no password is available',
  'command.interrupted': 'Command interrupted after {ms} ms',
  'command.timedOut': 'timed out after {ms} ms',
  'session.closed': 'SSH session closed',
  unreadable: 'unreadable output',

  'check.ssh': 'SSH connection',
  'check.ssh.detail': '{latency} ms',
  'check.ssh.key': '{latency} ms · key {key}',
  'check.os': 'Operating system',
  'check.sudo': 'Privilege elevation',
  'check.sudo.nopasswd': 'passwordless sudo',
  'check.sudo.password': 'sudo present, password required',
  'check.sudo.absent': 'no sudo',
  'check.tools': 'Tools found',
  'check.tools.none': 'none',
  'check.firewall': 'Firewall',
  'check.firewall.absent': 'ufw not installed',
  'check.firewall.active': {
    one: 'ufw active — {count} panel rule',
    other: 'ufw active — {count} panel rules',
  },
  'check.firewall.inactive': 'ufw installed but inactive',
  'check.docker.noBinary': 'binary not found',
  'check.docker.daemon': 'daemon unreachable: {detail}',
  'check.k3s.noKubectl': 'kubectl not found',
  'check.k3s.noCluster': 'kubectl found but no reachable cluster',
  'check.k3s.nodes': '{ready}/{total} node(s) ready{version}',
  'check.disk': 'Disk space',
  'check.disk.free': '{gib} GiB free ({percent}% used)',
  'check.disk.unreadable': 'unreadable df output',
  'check.memory': 'Memory',
  'check.memory.available': '{available} MiB available of {total}',
  'check.memory.unavailable': 'free not available',

  'metrics.load': 'Load average',
  'metrics.cores': 'Cores',
  'metrics.cores.count': { one: '{count} core', other: '{count} cores' },
  'metrics.memory.available': '{available} available of {total}',
  'metrics.memory.missing': 'MemTotal or MemAvailable missing',
  'metrics.disk.free': '{path} — {available} free ({percent}% used)',
  'metrics.uptime.days': { one: '{count} day', other: '{count} days' },
  'metrics.os': 'System',
  'metrics.unavailable': '{tool} not available: {detail}',
  'metrics.unreadableFile': '{file} unreadable',
  gib: '{value} GiB',
};

export const sshCopy = { fr, en };

export type SshSay = Translate<typeof fr>;

export function sshSay(language: UiLanguage): SshSay {
  return translator(sshCopy, language);
}
