import { translator, type Translate, type Translated, type UiLanguage } from '../../i18n.js';
import { proxyCopy } from '../messages.js';

/** What Traefik says, in the instance's language. See `../messages.ts`. */
const fr = {
  ...proxyCopy.fr,

  'detect.process': 'processus : {summary}',
  'detect.cluster': 'cluster : {summary}',
  'detect.binary': 'traefik (binaire)',

  'finding.noDirectory': 'Traefik « {name} » sans dossier surveillé',
  'finding.singleFile':
    'il lit un fichier unique ({file}) : Pupitre a besoin d’un dossier — ajoutez --providers.file.directory',
  'finding.noFileProvider':
    'le fournisseur « file » n’est pas activé : ajoutez --providers.file.directory et montez ce dossier depuis la machine',
  'finding.notMounted':
    'le dossier {directory} n’est pas monté depuis la machine : Pupitre ne peut pas y écrire',
  'finding.noHttp': 'aucun point d’entrée sur le port 80',
  'finding.noHttps': 'aucun point d’entrée sur le port 443 : pas de HTTPS',
  'finding.noResolver':
    'aucun résolveur ACME : les domaines seront servis avec le certificat par défaut',
  'finding.bridge':
    'Traefik est en réseau « {network} » : il joindra les applications par la passerelle {gateway}, et leur port restera ouvert sur la machine',
  'finding.networkUnreadable':
    'réseau du conteneur illisible : indiquez à quelle adresse Traefik joint la machine',
  'finding.summary': 'Traefik « {name} » ({image}) — dossier {directory}',
  'finding.unknownImage': 'image inconnue',
  'finding.noIngressClass': 'aucune IngressClass Traefik dans le cluster',
  'finding.noDeployment': 'le déploiement de Traefik n’a pas été trouvé : réglages par défaut',
  'finding.cluster': 'Traefik du cluster — IngressClass {ingressClass}',

  'option.k3s.title': 'Le Traefik de K3s',
  'option.k3s.foreign':
    'une HelmChartConfig « traefik » existe déjà dans kube-system : Pupitre ne l’écrase pas',
  'option.k3s.detail':
    'régler le Traefik livré avec K3s : certificats Let’s Encrypt et volume pour les garder',
  'option.container.title': 'Traefik en conteneur',
  'option.container.noDocker': 'Docker est absent ou inaccessible sur cette machine',
  'option.container.detail': 'installer {image} en conteneur, sur les ports 80 et 443',

  'install.answers': 'Traefik répond',
  'install.helm': 'HelmChartConfig traefik — résolveur ACME et volume des certificats',
  'install.notReconfigured': 'K3s n’a pas reconfiguré Traefik dans les temps',
  'install.noRestart': 'Traefik ne redémarre pas : {detail}',
  'install.port80Silent': 'Traefik est prêt, mais rien ne répond sur le port 80 de la machine',
  'install.restarted': 'Traefik redémarré avec le résolveur de certificats',

  'uninstall.settingsRemoved':
    'réglages de Traefik retirés : K3s revient à sa configuration par défaut',
  'uninstall.namespaceRemoved': 'namespace {namespace} retiré',
  'uninstall.removed': 'Traefik retiré de la machine',

  'check.directory': 'Dossier des routes',
  'check.directory.missing': '{directory} n’existe pas',
  'check.directory.sudo': '{directory} (écrit par sudo)',
  'check.reload': 'Traefik lit ce dossier',
  'check.reload.ok': 'une route d’essai y a été prise en compte',
  'check.reload.ignored': 'route d’essai ignorée ({code})',
  'check.ingressClass.missing': 'absente du cluster',
  'check.ready': 'Traefik prêt',
  'check.resolver': 'Résolveur « {name} »',
  'check.resolver.unknown': 'inconnu de ce Traefik',

  'apply.removed': 'routes retirées : {path}',
  'apply.fileNeedsPort':
    'ce Traefik lit des fichiers : il ne joint qu’une application publiée sur un port',
  'apply.written': 'routes écrites : {path} → {upstream}',
  'apply.removedFromNamespace': 'routes retirées du namespace {namespace}',
  'apply.needsIpv4':
    'le Traefik du cluster joint une autre machine par son adresse IPv4 — « {host} » n’en est pas une',
  'apply.clusterOnly':
    'ce Traefik vit dans le cluster : il joint une application du cluster, ou une autre machine par son adresse — pas un port de la sienne',
  'apply.ingresses': 'Ingress appliqués dans {namespace} : {hostnames}',
} as const;

const en: Translated<typeof fr> = {
  ...proxyCopy.en,

  'detect.process': 'process: {summary}',
  'detect.cluster': 'cluster: {summary}',
  'detect.binary': 'traefik (binary)',

  'finding.noDirectory': 'Traefik “{name}” without a watched folder',
  'finding.singleFile':
    'it reads a single file ({file}): Pupitre needs a folder — add --providers.file.directory',
  'finding.noFileProvider':
    'the “file” provider is not enabled: add --providers.file.directory and mount that folder from the machine',
  'finding.notMounted':
    'folder {directory} is not mounted from the machine: Pupitre cannot write to it',
  'finding.noHttp': 'no entry point on port 80',
  'finding.noHttps': 'no entry point on port 443: no HTTPS',
  'finding.noResolver': 'no ACME resolver: domains will be served with the default certificate',
  'finding.bridge':
    'Traefik uses the “{network}” network: it will reach applications through gateway {gateway}, and their port will stay open on the machine',
  'finding.networkUnreadable':
    'unreadable container network: say at which address Traefik reaches the machine',
  'finding.summary': 'Traefik “{name}” ({image}) — folder {directory}',
  'finding.unknownImage': 'unknown image',
  'finding.noIngressClass': 'no Traefik IngressClass in the cluster',
  'finding.noDeployment': 'the Traefik deployment was not found: default settings',
  'finding.cluster': 'cluster Traefik — IngressClass {ingressClass}',

  'option.k3s.title': 'The Traefik bundled with K3s',
  'option.k3s.foreign':
    'a “traefik” HelmChartConfig already exists in kube-system: Pupitre does not overwrite it',
  'option.k3s.detail':
    'configure the Traefik bundled with K3s: Let’s Encrypt certificates and a volume to keep them',
  'option.container.title': 'Traefik in a container',
  'option.container.noDocker': 'Docker is missing or unreachable on this machine',
  'option.container.detail': 'install {image} in a container, on ports 80 and 443',

  'install.answers': 'Traefik answers',
  'install.helm': 'HelmChartConfig traefik — ACME resolver and certificate volume',
  'install.notReconfigured': 'K3s did not reconfigure Traefik in time',
  'install.noRestart': 'Traefik does not restart: {detail}',
  'install.port80Silent': 'Traefik is ready, but nothing answers on port 80 of the machine',
  'install.restarted': 'Traefik restarted with the certificate resolver',

  'uninstall.settingsRemoved': 'Traefik settings removed: K3s is back to its default configuration',
  'uninstall.namespaceRemoved': 'namespace {namespace} removed',
  'uninstall.removed': 'Traefik removed from the machine',

  'check.directory': 'Routes folder',
  'check.directory.missing': '{directory} does not exist',
  'check.directory.sudo': '{directory} (written with sudo)',
  'check.reload': 'Traefik reads this folder',
  'check.reload.ok': 'a test route placed there was picked up',
  'check.reload.ignored': 'test route ignored ({code})',
  'check.ingressClass.missing': 'not in the cluster',
  'check.ready': 'Traefik ready',
  'check.resolver': 'Resolver “{name}”',
  'check.resolver.unknown': 'unknown to this Traefik',

  'apply.removed': 'routes removed: {path}',
  'apply.fileNeedsPort':
    'this Traefik reads files: it can only reach an application published on a port',
  'apply.written': 'routes written: {path} → {upstream}',
  'apply.removedFromNamespace': 'routes removed from namespace {namespace}',
  'apply.needsIpv4':
    'the cluster’s Traefik reaches another machine by its IPv4 address — “{host}” is not one',
  'apply.clusterOnly':
    'this Traefik lives in the cluster: it reaches a cluster application, or another machine by its address — not a port of its own machine',
  'apply.ingresses': 'Ingresses applied in {namespace}: {hostnames}',
};

export const traefikCopy = { fr, en };

export type TraefikSay = Translate<typeof fr>;

export function traefikSay(language: UiLanguage): TraefikSay {
  return translator(traefikCopy, language);
}
