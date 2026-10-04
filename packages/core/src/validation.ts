import { z } from 'zod';
import { renderMessage, type Translated, type UiLanguage, type Vars } from './i18n.js';
import { ssrfRefusalText, type SsrfRefusal } from './monitors/ssrf.js';

/**
 * Les reproches des schémas Zod de Pupitre, dans les deux langues.
 *
 * ── Pourquoi la phrase française reste le `message` ───────────────────────
 * Un schéma est une constante : il ne connaît pas la langue de qui le lira.
 * Le reproche garde donc sa phrase française — la valeur par défaut, celle
 * que lisent les tests et la boucle de correction de l'IA, dont le prompt est
 * en français — et porte **en plus** sa clé et ses variables dans `params`.
 * L'écran le redit dans sa langue au dernier moment (`issueMessage()`,
 * `localizeZodError()`), comme le journal d'activité rend ses entrées.
 *
 * Un contrôle intégré (`.min(1, '…')`, `.regex(…, '…')`) ne garde pas de
 * `params` : on le retrouve par sa phrase française, qui est sans variable.
 * Le transformer en `refine` aurait changé le schéma JSON envoyé à l'IA.
 */
const fr = {
  'spec.relativePath': 'chemin relatif attendu, sans « .. » ni « / » au début',
  'spec.atLeastOneService': 'au moins un service',
  'spec.duplicateServices': 'noms de services dupliqués : {names}',
  'spec.noExposed': 'exactement un service doit porter `exposed: true`, aucun ne le fait',
  'spec.tooManyExposed':
    'exactement un service doit porter `exposed: true`, {count} le font : {names}',
  'spec.unknownDependency': 'dépendance vers un service inconnu « {name} »',
  'spec.selfDependency': '« {name} » ne peut pas dépendre de lui-même',
  'spec.duplicateVolumes': 'noms de volumes dupliqués au sein du service',
  'spec.envAndSecrets': 'déclarés à la fois dans env et dans secrets : {names}',
  'spec.duplicateSecrets': 'noms de secrets dupliqués au sein du service : {names}',
  'spec.selfAlias': '« {name} » ne peut pas prendre sa valeur de lui-même',
  'spec.unknownAlias':
    '« {name} » prend sa valeur du secret inconnu « {from} » : aucun service de la spec ne le déclare',
  'spec.conflictingAlias':
    "« {name} » prend sa valeur de « {from} » ici et de « {other} » ailleurs dans la spec : un nom ne désigne qu'une valeur",
  'spec.aliasCycle': "cycle d'alias de secrets : {cycle}",
  'spec.bareAndAlias':
    '« {name} » est déclaré nu ici et comme alias de « {alias} » ailleurs : choisissez lequel des deux noms porte la valeur',
  'spec.dependencyCycle': 'cycle de dépendances : {cycle}',
  'spec.unknownIngressTarget': "l'ingress cible le service inconnu « {name} »",

  'monitor.keywordEmpty':
    'une sonde de mot-clé sans mot-clé ne constate rien — renseigner au moins le texte attendu ou le texte interdit',
  'monitor.resolverNotIp':
    "« {value} » n'est pas une adresse IP — un résolveur se déclare par son adresse",
  'monitor.hostShape': "un nom d'hôte, sans schéma ni port",
  'dns.empty': 'valeur vide',
  'dns.tooLong': 'valeur trop longue',
  'dns.notIpv4': "« {value} » n'est pas une adresse IPv4",
  'dns.notIpv6': "« {value} » n'est pas une adresse IPv6",
  'dns.notName': "« {value} » n'est pas un nom de domaine",
  'dns.mx': "un MX s'écrit « priorité hôte », par exemple « {example} »",
  'dns.srv': "un SRV s'écrit « priorité poids port hôte », par exemple « {example} »",
  'dns.caa': "un CAA s'écrit « drapeaux étiquette valeur », par exemple « {example} »",

  'hostname.empty': '« {host} » : vide',
  'hostname.tooLong': '« {host} » : plus de 253 caractères',
  'hostname.wildcard': '« {host} » : les jokers ne sont pas pris en charge',
  'hostname.ip': '« {host} » : une adresse IP n’est pas un domaine',
  'hostname.noDot': '« {host} » : il faut au moins un point (exemple.fr)',
  'hostname.invalid': '« {host} » : caractère ou libellé invalide',
  'routes.duplicate': '« {hostname} » apparaît deux fois',
  'npm.url': 'une adresse http:// ou https://',
  'notifications.emailList': 'Liste d’adresses e-mail invalide (séparées par des virgules)',
  'sources.repository': 'dépôt attendu sous la forme propriétaire/nom',
  'statusPage.duplicateBlocks': 'deux blocs portent le même identifiant',
  'statusUpdate.phase': 'cette phase ne convient pas à ce sujet',
  nothingToChange: 'rien à modifier',
  noFieldToChange: 'aucun champ à modifier',

  'targets.tooManyLabels': 'Pas plus de {max} étiquettes par cible',
  'targets.portRange': 'La borne basse de la plage de ports doit précéder la borne haute',
  'schedules.cronOrSchedule': 'fournir « cron » ou « schedule », pas les deux',
  'schedules.unreadable': 'périodicité illisible : « {value} »',
  'sources.specPath': 'chemin relatif à la racine du dépôt, sans « .. »',
  'sources.atLeastOneTarget': 'au moins une cible',
  'schedules.key': 'clé en minuscules, séparateurs `: . _ -`',
  'rbac.roleKey': 'clé en kebab-case : minuscules, chiffres et tirets',
  'backup.sftpSecret': 'mot de passe ou clé privée',
  'maintenance.endBeforeStart': 'la fin doit suivre le début',
  'maintenance.tooLong': 'une fenêtre dure au plus {days} jours',
  'maintenance.noSubject': 'une fenêtre couvre au moins une cible ou une sonde',
  'purge.criteria':
    'Au moins un critère est requis (ids, statuses, olderThanDays, applicationId, targetId)',
} as const;

const en: Translated<typeof fr> = {
  'spec.relativePath': 'relative path expected, without “..” or a leading “/”',
  'spec.atLeastOneService': 'at least one service',
  'spec.duplicateServices': 'duplicate service names: {names}',
  'spec.noExposed': 'exactly one service must have `exposed: true`, none does',
  'spec.tooManyExposed': 'exactly one service must have `exposed: true`, {count} do: {names}',
  'spec.unknownDependency': 'dependency on an unknown service “{name}”',
  'spec.selfDependency': '“{name}” cannot depend on itself',
  'spec.duplicateVolumes': 'duplicate volume names within the service',
  'spec.envAndSecrets': 'declared in both env and secrets: {names}',
  'spec.duplicateSecrets': 'duplicate secret names within the service: {names}',
  'spec.selfAlias': '“{name}” cannot take its value from itself',
  'spec.unknownAlias':
    '“{name}” takes its value from the unknown secret “{from}”: no service of the spec declares it',
  'spec.conflictingAlias':
    '“{name}” takes its value from “{from}” here and from “{other}” elsewhere in the spec: a name designates a single value',
  'spec.aliasCycle': 'secret alias cycle: {cycle}',
  'spec.bareAndAlias':
    '“{name}” is declared plainly here and as an alias of “{alias}” elsewhere: choose which of the two names carries the value',
  'spec.dependencyCycle': 'dependency cycle: {cycle}',
  'spec.unknownIngressTarget': 'the ingress targets the unknown service “{name}”',

  'monitor.keywordEmpty':
    'a keyword probe without a keyword observes nothing — fill in at least the expected text or the forbidden text',
  'monitor.resolverNotIp': '“{value}” is not an IP address — a resolver is declared by its address',
  'monitor.hostShape': 'a host name, without scheme or port',
  'dns.empty': 'empty value',
  'dns.tooLong': 'value too long',
  'dns.notIpv4': '“{value}” is not an IPv4 address',
  'dns.notIpv6': '“{value}” is not an IPv6 address',
  'dns.notName': '“{value}” is not a domain name',
  'dns.mx': 'an MX record is written “priority host”, for example “{example}”',
  'dns.srv': 'an SRV record is written “priority weight port host”, for example “{example}”',
  'dns.caa': 'a CAA record is written “flags tag value”, for example “{example}”',

  'hostname.empty': '“{host}”: empty',
  'hostname.tooLong': '“{host}”: more than 253 characters',
  'hostname.wildcard': '“{host}”: wildcards are not supported',
  'hostname.ip': '“{host}”: an IP address is not a domain',
  'hostname.noDot': '“{host}”: at least one dot is required (example.com)',
  'hostname.invalid': '“{host}”: invalid character or label',
  'routes.duplicate': '“{hostname}” appears twice',
  'npm.url': 'an http:// or https:// address',
  'notifications.emailList': 'Invalid list of e-mail addresses (comma separated)',
  'sources.repository': 'repository expected as owner/name',
  'statusPage.duplicateBlocks': 'two blocks have the same identifier',
  'statusUpdate.phase': 'this phase does not fit this subject',
  nothingToChange: 'nothing to change',
  noFieldToChange: 'no field to change',

  'targets.tooManyLabels': 'No more than {max} labels per target',
  'targets.portRange': 'The low end of the port range must come before the high end',
  'schedules.cronOrSchedule': 'give “cron” or “schedule”, not both',
  'schedules.unreadable': 'unreadable schedule: “{value}”',
  'sources.specPath': 'path relative to the repository root, without “..”',
  'sources.atLeastOneTarget': 'at least one target',
  'schedules.key': 'lowercase key, separators `: . _ -`',
  'rbac.roleKey': 'kebab-case key: lowercase letters, digits and dashes',
  'backup.sftpSecret': 'password or private key',
  'maintenance.endBeforeStart': 'the end must come after the start',
  'maintenance.tooLong': 'a window lasts at most {days} days',
  'maintenance.noSubject': 'a window covers at least one target or probe',
  'purge.criteria':
    'At least one criterion is required (ids, statuses, olderThanDays, applicationId, targetId)',
};

export const validationCopy = { fr, en };

export type ValidationKey = keyof typeof fr;

/** Ce qu'un reproche porte pour être redit : sa clé, et ses variables. */
export type ValidationRef = { key: ValidationKey; vars?: Vars };

/**
 * Le reproche d'un schéma : sa phrase française, et de quoi la redire dans une
 * autre langue. À étaler dans `ctx.addIssue({ … })` ou à passer à `.refine()`.
 */
export function invalid(
  key: ValidationKey,
  vars: Vars = {},
): { message: string; params: { i18n: ValidationRef } } {
  return {
    message: renderMessage(validationCopy, 'fr', key, vars),
    params: { i18n: { key, vars } },
  };
}

/** Les reproches sans variable, retrouvés par leur phrase française. */
const byFrenchText = new Map<string, ValidationKey>(
  (Object.entries(fr) as Array<[ValidationKey, string]>)
    .filter(([, text]) => !text.includes('{'))
    .map(([key, text]) => [text, key]),
);

/** Ce qu'un reproche dit, dans la langue demandée. Un reproche inconnu reste tel quel. */
export function issueMessage(
  issue: { message: string; params?: unknown },
  language: UiLanguage,
): string {
  const params = issue.params as { i18n?: ValidationRef; ssrf?: SsrfRefusal } | undefined;
  if (params?.i18n && params.i18n.key in fr) {
    return renderMessage(validationCopy, language, params.i18n.key, params.i18n.vars);
  }
  if (params?.ssrf) return ssrfRefusalText(params.ssrf, language);
  const known = byFrenchText.get(issue.message);
  return known ? renderMessage(validationCopy, language, known) : issue.message;
}

/**
 * Le même `ZodError`, ses reproches redits dans la langue demandée — à
 * appliquer juste avant de les montrer (`z.flattenError()`, une liste).
 */
export function localizeZodError<T>(error: z.ZodError<T>, language: UiLanguage): z.ZodError<T> {
  return new z.ZodError(
    error.issues.map((issue) => ({ ...issue, message: issueMessage(issue, language) })),
  ) as z.ZodError<T>;
}
