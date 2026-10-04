import { z } from "zod";
import { invalid } from "../validation.js";
import {
  translator,
  type Translate,
  type Translated,
  type UiLanguage,
} from "../i18n.js";
import {
  DNS_RECORD_TYPES_LIST,
  DNS_RECORD_TYPE_FORMATS,
  dnsMatchModeSchema,
  dnsRecordTypeSchema,
  parseExpectedRecords,
  dnsRecordProblem,
  type DnsMatchMode,
  type DnsRecordType,
} from "./dns-records.js";
import {
  checkAddress,
  checkNeverAllowable,
  classifyAddress,
  monitorHostSchema,
  monitorUrlSchema,
  type Cidr,
  type SsrfRefusal,
} from "./ssrf.js";

/**
 * Catalogue des types de sonde.
 *
 * ── La forme, et pourquoi celle-là ──────────────────────────────────────────
 * Superviser un site, ce n'est pas une chose mais six : disponibilité HTTP,
 * mot-clé dans la page, certificat TLS, enregistrements DNS, expiration de
 * domaine, empreinte de contenu. Ce ne sont pas six fonctionnalités — c'est
 * **une abstraction et six implémentations**, exactement la forme de `Scanner`
 * et de `DeploymentDriver`.
 *
 * D'où ce catalogue, sur le motif de `ai/catalog.ts` : une table de **données**
 * qui décrit, pour chaque type, son schéma de configuration, les champs que
 * l'écran doit afficher, les mesures qu'il rend, et sa cadence minimale. L'UI
 * se construit à partir de cette table ; il n'existe nulle part de
 * `if (type === 'http')`.
 *
 * La configuration propre à un type vit dans une colonne **JSONB** validée par
 * le schéma Zod du type — pas dans des colonnes dédiées à HTTP. La table
 * `monitors` ne porte que le commun : le type, la cadence, l'état, les seuils
 * de confirmation, le rattachement éventuel à une application.
 *
 * ── Deux conséquences, traitées ici ─────────────────────────────────────────
 *
 * 1. **La cadence dépend du type.** Une sonde HTTP à la minute est
 *    raisonnable ; interroger l'expiration d'un domaine toutes les minutes ne
 *    l'est pas — un domaine n'expire pas entre deux minutes, et ça harcèlerait
 *    les registres pour rien. Chaque type porte donc son `minIntervalSeconds`,
 *    et la validation le fait respecter.
 *
 * 2. **Les mesures dépendent du type.** Une sonde HTTP rend une latence et un
 *    code ; une sonde TLS rend des jours restants et un émetteur. Rien n'est
 *    forcé dans des colonnes HTTP : le résultat porte un espace de mesures
 *    structuré (`metrics`), et le catalogue dit à l'écran comment l'afficher.
 *
 * ── Ajouter un type ─────────────────────────────────────────────────────────
 * Une entrée ici, une implémentation sous `@pupitre/core/probe`, une ligne dans le
 * registre des sondes. Ni la table, ni le runner, ni les routes, ni l'écran ne
 * changent. `monitors.type` est volontairement du `text` et non un enum
 * Postgres : un enum ajouterait une migration à cette liste, et c'est
 * précisément la chirurgie qu'on veut éviter. Le vocabulaire reste fermé — il
 * est ici, et Zod le fait respecter à chaque entrée.
 *
 * ── L'empreinte de contenu, et pourquoi elle n'est pas là ───────────────────
 * Des six types annoncés plus haut, quatre sont écrits. Le sixième — alerter
 * quand une page **change** — n'est pas une variante du mot-clé, malgré la
 * ressemblance : une assertion de mot-clé est *sans mémoire* (une config, une
 * réponse, un verdict), tandis qu'une empreinte n'a de sens que comparée à la
 * précédente. Or `MonitorProbe.run(config, ctx)` ne reçoit pas l'état
 * antérieur, et c'est volontaire : c'est ce qui rend une sonde rejouable et
 * testable sans base.
 *
 * Le livrer « à moitié » aurait deux formes, toutes deux mauvaises : épingler
 * une empreinte dans la configuration, ce que personne ne sait remplir à la
 * main ; ou publier une empreinte comme simple mesure, qui scintillerait à
 * chaque jeton CSRF et n'alerterait de rien. Le faire correctement demande
 * d'élargir le contrat des sondes — une décision qui se prend, pas un effet de
 * bord d'un autre type.
 */

export const MONITOR_TYPES_LIST = [
  "http",
  "keyword",
  "tls",
  "tcp",
  "dns",
  "domain",
] as const;
export const monitorTypeSchema = z.enum(MONITOR_TYPES_LIST);
export type MonitorType = z.infer<typeof monitorTypeSchema>;

// ─── description des champs, pour que l'écran se construise tout seul ─────────

export type ConfigFieldBase = {
  key: string;
  label: string;
  hint?: string;
  /** Un champ optionnel peut être laissé vide ; sa valeur est alors `null`. */
  optional?: boolean;
  /** Champ de réglage fin, replié derrière « Options avancées ». */
  advanced?: boolean;
};

/**
 * `url` et `host` ne sont pas des habillages de saisie : ils **déclarent que le
 * worker ouvrira une socket vers cette valeur**. C'est ce marquage, et lui seul,
 * qui déclenche le contrôle d'adresse SSRF (`checkMonitorTargetLiterals`), sans
 * que personne n'ait à tenir une liste de « quels champs sont des cibles ».
 *
 * Corollaire, et il compte pour la sonde DNS : le nom qu'on **interroge** n'est
 * pas une cible de connexion — on ne s'y connecte jamais, on pose une question à
 * son sujet. Il se déclare donc en `text`, et c'est le **résolveur** qui porte
 * le `host`, parce que c'est lui, et lui seul, qu'on joint par le réseau.
 */
export type ConfigField = ConfigFieldBase &
  (
    | { kind: "url"; placeholder: string }
    | { kind: "host"; placeholder: string }
    | { kind: "text"; placeholder?: string }
    | { kind: "number"; min: number; max: number; step?: number; unit?: string }
    | {
        kind: "select";
        options: ReadonlyArray<{ value: string; label: string }>;
      }
  );

/** Comment afficher une mesure. L'écran ne connaît que ces formes. */
export type MetricDescriptor = {
  key: string;
  label: string;
  kind: "duration-ms" | "days" | "number" | "text" | "http-status";
  /** Mise en avant dans la liste, à côté de l'état. */
  primary?: boolean;
};

export type MonitorTypeDefinition<Config> = {
  type: MonitorType;
  label: string;
  /** Ce que ce type constate, en une phrase. */
  description: string;
  /** Ce qu'il **ne** constate **pas** — affiché dans l'écran, à dessein. */
  neverDoes: string;
  schema: z.ZodType<Config>;
  fields: readonly ConfigField[];
  metrics: readonly MetricDescriptor[];
  /**
   * Cadence minimale, en secondes. Par type parce que c'est une propriété du
   * type : ce qu'il coûte à l'autre bout, et la vitesse à laquelle ce qu'il
   * observe peut changer.
   */
  minIntervalSeconds: number;
  defaultIntervalSeconds: number;
  /** Valeurs de départ du formulaire. */
  defaults: Config;
  /** La cible, en une ligne, pour une liste. */
  describeTarget: (config: Config) => string;
  /** Lien cliquable vers la cible, quand ça a un sens. */
  linkFor: (config: Config) => string | null;
  /** Comment le taux de disponibilité de ce type se lit. */
  uptimeMeans: string;
};

// ─── les mots du catalogue ────────────────────────────────────────────────────

/**
 * Tout ce que le catalogue **affiche**, et rien d'autre.
 *
 * Les clés d'énumération (`http`, `lenient`, `A`), les schémas Zod, les bornes
 * et les valeurs de départ restent en dessous : ce sont des données, elles
 * n'ont pas de langue. Ce qui apparaît à l'écran — le nom d'un type, le libellé
 * d'un champ, l'aide de saisie, le nom d'une mesure — est ici, une fois, et le
 * compilateur refuse une traduction incomplète.
 *
 * Les libellés partagés par plusieurs types (« Hôte », « Code attendu »,
 * « Temps de réponse ») ne sont écrits qu'une fois, sous un préfixe neutre :
 * deux types qui affichent le même mot ne doivent pas pouvoir en donner deux
 * traductions différentes.
 */
const fr = {
  // ── Libellés partagés ───────────────────────────────────────────────────
  "field.url.label": "URL",
  "field.host.label": "Hôte",
  "field.port.label": "Port",
  "field.expectedStatus.label": "Code attendu",
  "field.timeout.label": "Délai d'expiration",
  "field.warnDays.label": "Préavis avant expiration",
  "field.matching.label": "Comparaison",
  "placeholder.domain": "exemple.fr",
  "metric.latencyMs": "Temps de réponse",
  "metric.httpStatus": "Code HTTP",
  "metric.redirects": "Redirections suivies",
  "metric.address": "Adresse jointe",
  "metric.daysRemaining": "Jours restants",
  "metric.expiresOn": "Expire le",
  "metric.certDaysRemaining": "Certificat",
  "metric.certValidTo": "Certificat valable jusqu'au",
  "unit.days": "jours",
  "unit.kib": "kio",
  /** Rendu quand la configuration ne se relit pas — voir `describeMonitorTarget`. */
  "target.unreadable": "(configuration illisible)",

  // ── http ────────────────────────────────────────────────────────────────
  "http.label": "Disponibilité HTTP",
  "http.description":
    "Une requête depuis le worker vers l'URL publique : code de réponse, temps de " +
    "réponse, et, si on le demande, présence d'un mot-clé dans la page.",
  "http.neverDoes":
    "Ne redémarre rien, ne redéploie rien. C'est un constat, pas une action.",
  "http.uptime": "part du temps où l'URL a répondu le code attendu",
  "http.field.url.placeholder": "https://exemple.fr/",
  "http.field.method.label": "Méthode",
  "http.field.method.hint":
    "HEAD évite de télécharger la page — mais interdit la recherche d'un mot-clé.",
  "http.field.keyword.label": "Mot-clé attendu",
  "http.field.keyword.placeholder": "facultatif",
  "http.field.keyword.hint":
    "Cherché dans les 256 premiers kio de la réponse. Absent = la sonde échoue.",

  // ── keyword ─────────────────────────────────────────────────────────────
  "keyword.label": "Mot-clé dans la page",
  "keyword.description":
    "Télécharge la page et vérifie ce qu'elle dit : un texte attendu, un texte " +
    "interdit, ou les deux. Un 200 prouve que le serveur répond ; le mot-clé " +
    "prouve que l'application répond — une page d'erreur, une page de " +
    "maintenance ou un site défiguré rendent 200 très volontiers.",
  "keyword.neverDoes":
    "Ne juge pas l'apparence de la page et n'exécute aucun JavaScript : ce qui " +
    "n'est écrit que par le navigateur ne sera pas trouvé.",
  "keyword.uptime": "part du temps où la page a répondu ce qu'on attend d'elle",
  "keyword.field.url.placeholder": "https://exemple.fr/connexion",
  "keyword.field.mustContain.label": "Texte attendu",
  "keyword.field.mustContain.placeholder": "Se connecter",
  "keyword.field.mustContain.hint": "Absent = la sonde échoue.",
  "keyword.field.mustNotContain.label": "Texte interdit",
  "keyword.field.mustNotContain.placeholder": "Erreur 500",
  "keyword.field.mustNotContain.hint":
    "Présent = la sonde échoue. Attrape la page d’erreur qui répond 200.",
  "keyword.field.matching.lenient": "Souple (recommandé)",
  "keyword.field.matching.strict": "Stricte, au caractère près",
  "keyword.field.matching.hint":
    "Souple : casse, accents et espaces indifférents — une espace insécable ne " +
    "doit pas réveiller quelqu’un à trois heures du matin.",
  "keyword.field.scope.label": "Chercher dans",
  "keyword.field.scope.raw": "La réponse telle quelle",
  "keyword.field.scope.text": "Le texte, balises retirées",
  "keyword.field.scope.hint":
    "Balises retirées : approximation par expressions régulières, pas un analyseur " +
    "HTML. Utile surtout pour un texte interdit, qu’un commentaire ferait sonner à tort.",
  "keyword.field.expectedStatus.hint":
    "Une page 404 peut très bien contenir le mot attendu.",
  "keyword.field.maxKib.label": "Lecture maximale",
  "keyword.field.maxKib.hint":
    "Au-delà, la sonde coupe et le dit — elle ne fait jamais passer une coupure pour une absence.",
  "keyword.metric.bytesRead": "Octets lus",
  "keyword.metric.truncated": "Réponse coupée",
  "keyword.metric.finalUrl": "URL finale",

  // ── tls ─────────────────────────────────────────────────────────────────
  "tls.label": "Certificat TLS",
  "tls.description":
    "Une poignée de main TLS depuis le worker : date d'expiration, émetteur, " +
    "version du protocole. Prévient la panne la plus bête et la plus totale qui " +
    "soit — un certificat expiré, que personne ne voit venir.",
  "tls.neverDoes":
    "Ne renouvelle aucun certificat et ne touche à aucune configuration.",
  "tls.uptime": "part du temps où le certificat était valide et hors préavis",
  "tls.field.servername.label": "Nom SNI",
  "tls.field.servername.placeholder": "identique à l'hôte",
  "tls.field.warnDays.hint":
    "En deçà, la sonde passe en échec — pour alerter avant la panne, pas pendant.",
  "tls.metric.issuer": "Émetteur",
  "tls.metric.subject": "Sujet",
  "tls.metric.protocol": "Protocole",
  "tls.metric.handshakeMs": "Poignée de main",

  // ── tcp ─────────────────────────────────────────────────────────────────
  "tcp.label": "Port TCP",
  "tcp.description":
    "Une connexion TCP depuis le worker vers un hôte et un port : le port accepte-t-il " +
    "la connexion, en combien de temps, et — si on le demande — le service " +
    "annonce-t-il bien la bannière attendue.",
  "tcp.neverDoes":
    "N'envoie aucun octet à la cible et ne parle aucun protocole : elle écoute, elle " +
    "ne sollicite pas. Un service où le client parle en premier ne rendra donc jamais " +
    "de bannière.",
  "tcp.uptime": "part du temps où le port a accepté la connexion",
  "tcp.field.expectBanner.label": "Bannière attendue",
  "tcp.field.expectBanner.placeholder": "facultatif — par exemple SSH-2.0",
  "tcp.field.expectBanner.hint":
    "Cherchée sans égard à la casse dans les premiers octets que le service envoie " +
    "de lui-même. Vide : la poignée TCP suffit. Renseignée face à un service qui " +
    "n'annonce rien (PostgreSQL, MySQL, HTTP), la sonde attendra le délai entier.",
  "tcp.metric.connectMs": "Établissement",
  "tcp.metric.banner": "Bannière reçue",
  "tcp.metric.bannerMs": "Attente de la bannière",

  // ── dns ─────────────────────────────────────────────────────────────────
  "dns.label": "Enregistrements DNS",
  "dns.description":
    "Une interrogation DNS depuis le worker : les enregistrements du type demandé " +
    "existent-ils, et valent-ils ce qu'on a déclaré. La comparaison ignore l'ordre " +
    "et la casse des noms — un résolveur permute ses réponses, ce n'est pas un incident.",
  "dns.neverDoes":
    "Ne modifie aucune zone et n'interroge pas le registre du domaine : elle lit des " +
    "enregistrements, elle ne dit rien de l'expiration du nom.",
  "dns.uptime": "part du temps où les enregistrements étaient ceux qu'on attend",
  "dns.field.name.label": "Nom interrogé",
  "dns.field.recordType.label": "Type d'enregistrement",
  "dns.field.expected.label": "Valeurs attendues",
  "dns.field.expected.placeholder": "laisser vide pour ne vérifier que la présence",
  "dns.field.expected.hint":
    "Séparées par des virgules ou des retours à la ligne (retours à la ligne " +
    "seulement pour TXT, dont la valeur peut contenir une virgule). Formats : A " +
    "« {a} », MX « {mx} », CAA « {caa} », SRV « {srv} ».",
  "dns.field.match.exact": "Exactement ces valeurs — un ajout est une anomalie",
  "dns.field.match.contains": "Au moins ces valeurs — le reste est toléré",
  "dns.field.match.hint":
    "« Exactement » détecte l'enregistrement ajouté, la signature d'un détournement. " +
    "« Au moins » sert pour TXT, où un domaine porte de front un SPF, un DKIM et " +
    "des preuves de propriété dont on ne veut pas tenir l'inventaire.",
  "dns.field.resolver.label": "Résolveur",
  "dns.field.resolver.placeholder": "celui du système",
  "dns.field.resolver.hint":
    "Une adresse IP. Vide : le résolveur du conteneur worker — ce que voit une " +
    "machine du parc. Un résolveur public (1.1.1.1, 9.9.9.9) mesure plutôt ce que " +
    "voit le monde, et contourne le cache local.",
  "dns.record.A": "A — adresse IPv4",
  "dns.record.AAAA": "AAAA — adresse IPv6",
  "dns.record.CNAME": "CNAME — alias",
  "dns.record.MX": "MX — serveurs de courrier",
  "dns.record.NS": "NS — serveurs de noms (délégation)",
  "dns.record.TXT": "TXT — SPF, DKIM, DMARC, preuves de propriété",
  "dns.record.CAA": "CAA — autorités de certification autorisées",
  "dns.record.SRV": "SRV — découverte de service",
  "dns.metric.resolveMs": "Temps de résolution",
  "dns.metric.recordCount": "Enregistrements",
  "dns.metric.values": "Valeurs observées",
  "dns.metric.missing": "Attendues et absentes",
  "dns.metric.unexpected": "Observées en trop",
  "dns.metric.resolver": "Résolveur interrogé",
  "dns.metric.minTtl": "TTL le plus court",

  // ── domain ──────────────────────────────────────────────────────────────
  "domain.label": "Expiration de domaine",
  "domain.description":
    "Interroge le registre en RDAP : date d’expiration, registrar, serveurs de " +
    "noms, statuts. Prévient la panne dont on ne se relève pas en une heure — un " +
    "domaine expiré, c’est le site, les courriels et les certificats en même temps.",
  "domain.neverDoes":
    "Ne renouvelle rien, ne paie rien, et ne vérifie pas que le domaine pointe " +
    "quelque part — c’est le registre qu’elle lit, pas le DNS.",
  "domain.uptime":
    "part du temps où le domaine était enregistré, hors préavis, et conforme à ce qui est attendu",
  "domain.field.domain.label": "Nom de domaine",
  "domain.field.domain.hint":
    "Le domaine enregistré, pas un sous-domaine : « exemple.fr », pas « www.exemple.fr ».",
  "domain.field.warnDays.hint":
    "En deçà, la sonde passe en échec — pour alerter tant qu’il reste le temps d’agir.",
  "domain.field.expectedRegistrar.label": "Registrar attendu",
  "domain.field.expectedRegistrar.placeholder": "OVH",
  "domain.field.expectedRegistrar.hint":
    "Renseigné, un changement de registrar fait échouer la sonde : c’est ainsi qu’un transfert non voulu se voit.",
  "domain.field.nameserverSuffix.label": "Suffixe des serveurs de noms",
  "domain.field.nameserverSuffix.placeholder": "ovh.net",
  "domain.field.nameserverSuffix.hint":
    "Renseigné, la sonde échoue si plus aucun serveur de noms ne finit par ce suffixe.",
  "domain.field.transferLock.label": "Verrou de transfert",
  "domain.field.transferLock.off": "Ne pas vérifier",
  "domain.field.transferLock.required": "Exiger clientTransferProhibited",
  "domain.field.transferLock.hint":
    "Tous les registres ne publient pas leurs statuts EPP — « .fr » n’annonce souvent qu’« active ».",
  "domain.metric.registrar": "Registrar",
  "domain.metric.nameservers": "Serveurs de noms",
  "domain.metric.eppStatus": "Statuts",
  "domain.metric.registeredOn": "Enregistré le",
  "domain.metric.lastChangedOn": "Dernière modification",
  "domain.metric.rdapServer": "Serveur RDAP",
} as const;

const en: Translated<typeof fr> = {
  "field.url.label": "URL",
  "field.host.label": "Host",
  "field.port.label": "Port",
  "field.expectedStatus.label": "Expected status",
  "field.timeout.label": "Timeout",
  "field.warnDays.label": "Warning lead time",
  "field.matching.label": "Matching",
  "placeholder.domain": "example.com",
  "metric.latencyMs": "Response time",
  "metric.httpStatus": "HTTP status",
  "metric.redirects": "Redirects followed",
  "metric.address": "Address reached",
  "metric.daysRemaining": "Days remaining",
  "metric.expiresOn": "Expires on",
  "metric.certDaysRemaining": "Certificate",
  "metric.certValidTo": "Certificate valid until",
  "unit.days": "days",
  "unit.kib": "KiB",
  "target.unreadable": "(unreadable configuration)",

  "http.label": "HTTP availability",
  "http.description":
    "One request from the worker to the public URL: status code, response time, " +
    "and, if you ask for it, a keyword in the page.",
  "http.neverDoes":
    "Restarts nothing, redeploys nothing. It observes, it does not act.",
  "http.uptime": "share of the time the URL answered the expected status",
  "http.field.url.placeholder": "https://example.com/",
  "http.field.method.label": "Method",
  "http.field.method.hint":
    "HEAD skips downloading the page — but rules out any keyword search.",
  "http.field.keyword.label": "Expected keyword",
  "http.field.keyword.placeholder": "optional",
  "http.field.keyword.hint":
    "Searched in the first 256 KiB of the response. Missing = the probe fails.",

  "keyword.label": "Keyword in the page",
  "keyword.description":
    "Downloads the page and checks what it says: an expected text, a forbidden " +
    "text, or both. A 200 proves the server answers; the keyword proves the " +
    "application answers — an error page, a maintenance page or a defaced site " +
    "return 200 quite happily.",
  "keyword.neverDoes":
    "Does not judge how the page looks and runs no JavaScript: whatever only the " +
    "browser writes will not be found.",
  "keyword.uptime": "share of the time the page answered what you expect of it",
  "keyword.field.url.placeholder": "https://example.com/login",
  "keyword.field.mustContain.label": "Expected text",
  "keyword.field.mustContain.placeholder": "Sign in",
  "keyword.field.mustContain.hint": "Missing = the probe fails.",
  "keyword.field.mustNotContain.label": "Forbidden text",
  "keyword.field.mustNotContain.placeholder": "Error 500",
  "keyword.field.mustNotContain.hint":
    "Present = the probe fails. Catches the error page that answers 200.",
  "keyword.field.matching.lenient": "Lenient (recommended)",
  "keyword.field.matching.strict": "Strict, character for character",
  "keyword.field.matching.hint":
    "Lenient: case, accents and spacing ignored — a non-breaking space must not " +
    "wake someone at three in the morning.",
  "keyword.field.scope.label": "Search in",
  "keyword.field.scope.raw": "The response as it comes",
  "keyword.field.scope.text": "The text, tags stripped",
  "keyword.field.scope.hint":
    "Tags stripped: a regular-expression approximation, not an HTML parser. Mostly " +
    "useful for a forbidden text, which a comment would trip.",
  "keyword.field.expectedStatus.hint":
    "A 404 page may well contain the expected word.",
  "keyword.field.maxKib.label": "Read at most",
  "keyword.field.maxKib.hint":
    "Past that the probe cuts and says so — it never passes a cut off for an absence.",
  "keyword.metric.bytesRead": "Bytes read",
  "keyword.metric.truncated": "Response cut",
  "keyword.metric.finalUrl": "Final URL",

  "tls.label": "TLS certificate",
  "tls.description":
    "One TLS handshake from the worker: expiry date, issuer, protocol version. " +
    "Heads off the dumbest and most total outage there is — an expired " +
    "certificate, which nobody sees coming.",
  "tls.neverDoes": "Renews no certificate and touches no configuration.",
  "tls.uptime":
    "share of the time the certificate was valid and outside the warning window",
  "tls.field.servername.label": "SNI name",
  "tls.field.servername.placeholder": "same as the host",
  "tls.field.warnDays.hint":
    "Below that the probe fails — to alert before the outage, not during.",
  "tls.metric.issuer": "Issuer",
  "tls.metric.subject": "Subject",
  "tls.metric.protocol": "Protocol",
  "tls.metric.handshakeMs": "Handshake",

  "tcp.label": "TCP port",
  "tcp.description":
    "One TCP connection from the worker to a host and a port: does the port accept " +
    "the connection, how fast, and — if you ask for it — does the service announce " +
    "the expected banner.",
  "tcp.neverDoes":
    "Sends no byte to the target and speaks no protocol: it listens, it does not " +
    "solicit. A service where the client speaks first will therefore never yield a banner.",
  "tcp.uptime": "share of the time the port accepted the connection",
  "tcp.field.expectBanner.label": "Expected banner",
  "tcp.field.expectBanner.placeholder": "optional — for instance SSH-2.0",
  "tcp.field.expectBanner.hint":
    "Searched case-insensitively in the first bytes the service sends on its own. " +
    "Empty: the TCP handshake is enough. Set against a service that announces " +
    "nothing (PostgreSQL, MySQL, HTTP), the probe waits out the whole timeout.",
  "tcp.metric.connectMs": "Connect",
  "tcp.metric.banner": "Banner received",
  "tcp.metric.bannerMs": "Wait for banner",

  "dns.label": "DNS records",
  "dns.description":
    "One DNS query from the worker: do the records of the requested type exist, and " +
    "do they hold what you declared. The comparison ignores order and the case of " +
    "names — a resolver shuffles its answers, that is not an incident.",
  "dns.neverDoes":
    "Changes no zone and does not query the domain registry: it reads records, it " +
    "says nothing about the name expiring.",
  "dns.uptime": "share of the time the records were the ones you expect",
  "dns.field.name.label": "Name queried",
  "dns.field.recordType.label": "Record type",
  "dns.field.expected.label": "Expected values",
  "dns.field.expected.placeholder": "leave empty to check presence only",
  "dns.field.expected.hint":
    "Separated by commas or line breaks (line breaks only for TXT, whose value may " +
    "contain a comma). Formats: A “{a}”, MX “{mx}”, CAA “{caa}”, SRV “{srv}”.",
  "dns.field.match.exact": "Exactly these values — an addition is an anomaly",
  "dns.field.match.contains": "At least these values — the rest is tolerated",
  "dns.field.match.hint":
    "“Exactly” catches the added record, the signature of a hijack. “At least” is " +
    "for TXT, where a domain carries an SPF, a DKIM and ownership proofs you do not " +
    "want to keep an inventory of.",
  "dns.field.resolver.label": "Resolver",
  "dns.field.resolver.placeholder": "the system one",
  "dns.field.resolver.hint":
    "An IP address. Empty: the worker container’s resolver — what a machine in the " +
    "fleet sees. A public resolver (1.1.1.1, 9.9.9.9) measures what the world sees " +
    "instead, and bypasses the local cache.",
  "dns.record.A": "A — IPv4 address",
  "dns.record.AAAA": "AAAA — IPv6 address",
  "dns.record.CNAME": "CNAME — alias",
  "dns.record.MX": "MX — mail servers",
  "dns.record.NS": "NS — name servers (delegation)",
  "dns.record.TXT": "TXT — SPF, DKIM, DMARC, ownership proofs",
  "dns.record.CAA": "CAA — allowed certificate authorities",
  "dns.record.SRV": "SRV — service discovery",
  "dns.metric.resolveMs": "Resolution time",
  "dns.metric.recordCount": "Records",
  "dns.metric.values": "Values observed",
  "dns.metric.missing": "Expected and missing",
  "dns.metric.unexpected": "Observed in excess",
  "dns.metric.resolver": "Resolver queried",
  "dns.metric.minTtl": "Shortest TTL",

  "domain.label": "Domain expiry",
  "domain.description":
    "Queries the registry over RDAP: expiry date, registrar, name servers, " +
    "statuses. Heads off the outage you do not recover from in an hour — an expired " +
    "domain takes the site, the mail and the certificates at once.",
  "domain.neverDoes":
    "Renews nothing, pays nothing, and does not check that the domain points " +
    "anywhere — it reads the registry, not the DNS.",
  "domain.uptime":
    "share of the time the domain was registered, outside the warning window, and as expected",
  "domain.field.domain.label": "Domain name",
  "domain.field.domain.hint":
    "The registered domain, not a subdomain: “example.com”, not “www.example.com”.",
  "domain.field.warnDays.hint":
    "Below that the probe fails — to alert while there is still time to act.",
  "domain.field.expectedRegistrar.label": "Expected registrar",
  "domain.field.expectedRegistrar.placeholder": "OVH",
  "domain.field.expectedRegistrar.hint":
    "Set, a change of registrar fails the probe: that is how an unwanted transfer shows up.",
  "domain.field.nameserverSuffix.label": "Name server suffix",
  "domain.field.nameserverSuffix.placeholder": "ovh.net",
  "domain.field.nameserverSuffix.hint":
    "Set, the probe fails once no name server ends with this suffix.",
  "domain.field.transferLock.label": "Transfer lock",
  "domain.field.transferLock.off": "Do not check",
  "domain.field.transferLock.required": "Require clientTransferProhibited",
  "domain.field.transferLock.hint":
    "Not every registry publishes its EPP statuses — “.fr” often announces only “active”.",
  "domain.metric.registrar": "Registrar",
  "domain.metric.nameservers": "Name servers",
  "domain.metric.eppStatus": "Statuses",
  "domain.metric.registeredOn": "Registered on",
  "domain.metric.lastChangedOn": "Last changed",
  "domain.metric.rdapServer": "RDAP server",
};

export const monitorCatalogCopy = { fr, en };

type CatalogTranslate = Translate<typeof fr>;

// ─── http ─────────────────────────────────────────────────────────────────────

export const HTTP_METHODS = ["GET", "HEAD", "POST"] as const;
export const httpMethodSchema = z.enum(HTTP_METHODS);
export type HttpMethod = z.infer<typeof httpMethodSchema>;

export const httpConfigSchema = z.object({
  url: monitorUrlSchema,
  method: httpMethodSchema.default("GET"),
  expectedStatus: z.number().int().min(100).max(599).default(200),
  /**
   * Mot-clé à trouver dans le corps. Option de la sonde HTTP, et non type à
   * part : c'est la même requête, on regarde simplement une chose de plus.
   */
  keyword: z.string().trim().min(1).max(200).nullable().default(null),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
});

export type HttpConfig = z.infer<typeof httpConfigSchema>;

const httpDefinition = (t: CatalogTranslate): MonitorTypeDefinition<HttpConfig> => ({
  type: "http",
  label: t("http.label"),
  description: t("http.description"),
  neverDoes: t("http.neverDoes"),
  schema: httpConfigSchema,
  fields: [
    {
      key: "url",
      kind: "url",
      label: t("field.url.label"),
      placeholder: t("http.field.url.placeholder"),
    },
    {
      key: "method",
      kind: "select",
      label: t("http.field.method.label"),
      advanced: true,
      options: HTTP_METHODS.map((method) => ({ value: method, label: method })),
      hint: t("http.field.method.hint"),
    },
    {
      key: "expectedStatus",
      kind: "number",
      label: t("field.expectedStatus.label"),
      min: 100,
      max: 599,
      advanced: true,
    },
    {
      key: "keyword",
      kind: "text",
      label: t("http.field.keyword.label"),
      optional: true,
      placeholder: t("http.field.keyword.placeholder"),
      hint: t("http.field.keyword.hint"),
    },
    {
      key: "timeoutMs",
      kind: "number",
      label: t("field.timeout.label"),
      min: 1_000,
      max: 30_000,
      step: 500,
      unit: "ms",
      advanced: true,
    },
  ],
  metrics: [
    {
      key: "latencyMs",
      label: t("metric.latencyMs"),
      kind: "duration-ms",
      primary: true,
    },
    {
      key: "httpStatus",
      label: t("metric.httpStatus"),
      kind: "http-status",
      primary: true,
    },
    { key: "redirects", label: t("metric.redirects"), kind: "number" },
    { key: "address", label: t("metric.address"), kind: "text" },
    { key: "certDaysRemaining", label: t("metric.certDaysRemaining"), kind: "days" },
    { key: "certValidTo", label: t("metric.certValidTo"), kind: "text" },
  ],
  // Trente secondes : en dessous, une sonde coûte plus au worker qu'elle ne
  // rapporte, et la série temporelle double pour détecter une panne trois
  // secondes plus tôt.
  minIntervalSeconds: 30,
  defaultIntervalSeconds: 60,
  defaults: {
    url: "",
    method: "GET",
    expectedStatus: 200,
    keyword: null,
    timeoutMs: 10_000,
  },
  describeTarget: (config) => config.url,
  linkFor: (config) => (config.url === "" ? null : config.url),
  uptimeMeans: t("http.uptime"),
});

// ─── keyword ──────────────────────────────────────────────────────────────────

/**
 * Comment on compare. Deux intentions nommées plutôt que trois interrupteurs
 * orthogonaux (casse, accents, espaces) que personne ne combine correctement.
 */
export const KEYWORD_MATCHINGS = ["lenient", "strict"] as const;
export const keywordMatchingSchema = z.enum(KEYWORD_MATCHINGS);
export type KeywordMatching = z.infer<typeof keywordMatchingSchema>;

/** Sur quoi on cherche : la réponse telle quelle, ou une approximation du texte. */
export const KEYWORD_SCOPES = ["raw", "text"] as const;
export const keywordScopeSchema = z.enum(KEYWORD_SCOPES);
export type KeywordScope = z.infer<typeof keywordScopeSchema>;

/** Plafond de lecture, en kio. Voir `maxKib` pour le raisonnement. */
export const KEYWORD_MIN_KIB = 16;
export const KEYWORD_MAX_KIB = 2048;

export const keywordConfigSchema = z
  .object({
    url: monitorUrlSchema,
    /**
     * **Présence et absence, les deux.** Ce sont deux besoins réels et opposés :
     * « la page de connexion doit dire *Se connecter* » prouve que
     * l'application rend ; « elle ne doit pas dire *Erreur 500* » attrape la
     * page d'erreur applicative qui répond fièrement 200. Refuser l'un des deux
     * obligerait à sonder deux fois la même page pour deux moitiés de la même
     * question.
     *
     * Un mot-clé par champ, et non une liste. Cinq mots-clés dans une sonde ne
     * donnent qu'un seul voyant rouge ; cinq sondes disent lequel a lâché. Le
     * jour où la liste s'impose, elle demandera une forme de champ que l'écran
     * ne sait pas encore rendre — c'est-à-dire une modification d'écran, donc
     * une décision, pas un effet de bord.
     */
    mustContain: z.string().trim().min(1).max(200).nullable().default(null),
    mustNotContain: z.string().trim().min(1).max(200).nullable().default(null),
    matching: keywordMatchingSchema.default("lenient"),
    scope: keywordScopeSchema.default("raw"),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    /**
     * Ce qu'on accepte de télécharger pour y chercher un mot.
     *
     * Les deux bornes sont des vrais problèmes : tirer 40 Mo toutes les minutes
     * pour un mot est une charge absurde ; s'arrêter à 64 kio rate un pied de
     * page. 512 kio par défaut couvre très largement une page HTML servie
     * proprement, et la sonde **dit** quand elle a coupé — un mot-clé « absent »
     * d'une réponse tronquée n'est pas la même information qu'un mot-clé absent
     * d'une réponse complète, et le message ne les confond pas.
     */
    maxKib: z
      .number()
      .int()
      .min(KEYWORD_MIN_KIB)
      .max(KEYWORD_MAX_KIB)
      .default(512),
    timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
  })
  .superRefine((config, ctx) => {
    if (config.mustContain === null && config.mustNotContain === null) {
      ctx.addIssue({
        code: "custom",
        path: ["mustContain"],
        ...invalid("monitor.keywordEmpty"),
      });
    }
  });

export type KeywordConfig = z.infer<typeof keywordConfigSchema>;

const keywordDefinition = (
  t: CatalogTranslate,
): MonitorTypeDefinition<KeywordConfig> => ({
  type: "keyword",
  label: t("keyword.label"),
  description: t("keyword.description"),
  neverDoes: t("keyword.neverDoes"),
  schema: keywordConfigSchema,
  fields: [
    {
      key: "url",
      kind: "url",
      label: t("field.url.label"),
      placeholder: t("keyword.field.url.placeholder"),
    },
    {
      key: "mustContain",
      kind: "text",
      label: t("keyword.field.mustContain.label"),
      optional: true,
      placeholder: t("keyword.field.mustContain.placeholder"),
      hint: t("keyword.field.mustContain.hint"),
    },
    {
      key: "mustNotContain",
      kind: "text",
      label: t("keyword.field.mustNotContain.label"),
      optional: true,
      placeholder: t("keyword.field.mustNotContain.placeholder"),
      hint: t("keyword.field.mustNotContain.hint"),
    },
    {
      key: "matching",
      kind: "select",
      label: t("field.matching.label"),
      options: [
        { value: "lenient", label: t("keyword.field.matching.lenient") },
        { value: "strict", label: t("keyword.field.matching.strict") },
      ],
      hint: t("keyword.field.matching.hint"),
    },
    {
      key: "scope",
      kind: "select",
      label: t("keyword.field.scope.label"),
      advanced: true,
      options: [
        { value: "raw", label: t("keyword.field.scope.raw") },
        { value: "text", label: t("keyword.field.scope.text") },
      ],
      hint: t("keyword.field.scope.hint"),
    },
    {
      key: "expectedStatus",
      kind: "number",
      label: t("field.expectedStatus.label"),
      min: 100,
      max: 599,
      advanced: true,
      hint: t("keyword.field.expectedStatus.hint"),
    },
    {
      key: "maxKib",
      kind: "number",
      label: t("keyword.field.maxKib.label"),
      min: KEYWORD_MIN_KIB,
      max: KEYWORD_MAX_KIB,
      step: 16,
      unit: t("unit.kib"),
      advanced: true,
      hint: t("keyword.field.maxKib.hint"),
    },
    {
      key: "timeoutMs",
      kind: "number",
      label: t("field.timeout.label"),
      min: 1_000,
      max: 30_000,
      step: 500,
      unit: "ms",
      advanced: true,
    },
  ],
  metrics: [
    {
      key: "latencyMs",
      label: t("metric.latencyMs"),
      kind: "duration-ms",
      primary: true,
    },
    {
      key: "httpStatus",
      label: t("metric.httpStatus"),
      kind: "http-status",
      primary: true,
    },
    { key: "bytesRead", label: t("keyword.metric.bytesRead"), kind: "number" },
    { key: "truncated", label: t("keyword.metric.truncated"), kind: "text" },
    { key: "redirects", label: t("metric.redirects"), kind: "number" },
    { key: "address", label: t("metric.address"), kind: "text" },
    { key: "finalUrl", label: t("keyword.metric.finalUrl"), kind: "text" },
    { key: "certDaysRemaining", label: t("metric.certDaysRemaining"), kind: "days" },
    { key: "certValidTo", label: t("metric.certValidTo"), kind: "text" },
  ],
  // Même cadence que HTTP : c'est la même requête, avec un peu de lecture en
  // plus. Ce qui coûte, c'est le nombre de requêtes, pas ce qu'on en fait.
  minIntervalSeconds: 30,
  defaultIntervalSeconds: 60,
  defaults: {
    url: "",
    mustContain: null,
    mustNotContain: null,
    matching: "lenient",
    scope: "raw",
    expectedStatus: 200,
    maxKib: 512,
    timeoutMs: 10_000,
  },
  describeTarget: (config) => config.url,
  linkFor: (config) => (config.url === "" ? null : config.url),
  uptimeMeans: t("keyword.uptime"),
});

// ─── tls ──────────────────────────────────────────────────────────────────────

export const tlsConfigSchema = z.object({
  host: monitorHostSchema,
  port: z.number().int().min(1).max(65_535).default(443),
  /**
   * Nom présenté en SNI, quand il diffère de l'hôte joint. Utile pour vérifier
   * le certificat d'un vhost derrière une adresse partagée.
   */
  servername: z.string().trim().min(1).max(253).nullable().default(null),
  /**
   * Préavis, en jours. Ce **n'est pas** un simple avertissement : en deçà, la
   * sonde passe en échec. Une sonde de certificat n'a d'intérêt que si elle
   * alerte *avant* la panne ; attendre l'expiration reviendrait à constater
   * l'incendie. Le taux de disponibilité d'une sonde TLS se lit donc « part du
   * temps où le certificat était valide **et pas en fin de vie** ».
   */
  warnDays: z.number().int().min(1).max(180).default(21),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
});

export type TlsConfig = z.infer<typeof tlsConfigSchema>;

const tlsDefinition = (t: CatalogTranslate): MonitorTypeDefinition<TlsConfig> => ({
  type: "tls",
  label: t("tls.label"),
  description: t("tls.description"),
  neverDoes: t("tls.neverDoes"),
  schema: tlsConfigSchema,
  fields: [
    {
      key: "host",
      kind: "host",
      label: t("field.host.label"),
      placeholder: t("placeholder.domain"),
    },
    { key: "port", kind: "number", label: t("field.port.label"), min: 1, max: 65_535 },
    {
      key: "servername",
      kind: "text",
      label: t("tls.field.servername.label"),
      optional: true,
      advanced: true,
      placeholder: t("tls.field.servername.placeholder"),
    },
    {
      key: "warnDays",
      kind: "number",
      label: t("field.warnDays.label"),
      min: 1,
      max: 180,
      unit: t("unit.days"),
      hint: t("tls.field.warnDays.hint"),
    },
    {
      key: "timeoutMs",
      kind: "number",
      label: t("field.timeout.label"),
      min: 1_000,
      max: 30_000,
      step: 500,
      unit: "ms",
      advanced: true,
    },
  ],
  metrics: [
    {
      key: "daysRemaining",
      label: t("metric.daysRemaining"),
      kind: "days",
      primary: true,
    },
    { key: "validTo", label: t("metric.expiresOn"), kind: "text", primary: true },
    { key: "issuer", label: t("tls.metric.issuer"), kind: "text" },
    { key: "subject", label: t("tls.metric.subject"), kind: "text" },
    { key: "protocol", label: t("tls.metric.protocol"), kind: "text" },
    { key: "handshakeMs", label: t("tls.metric.handshakeMs"), kind: "duration-ms" },
  ],
  // Une heure : un certificat ne change pas plus vite, et chaque mesure est une
  // poignée de main TLS complète chez quelqu'un d'autre.
  minIntervalSeconds: 3_600,
  defaultIntervalSeconds: 6 * 3_600,
  defaults: {
    host: "",
    port: 443,
    servername: null,
    warnDays: 21,
    timeoutMs: 10_000,
  },
  describeTarget: (config) =>
    config.port === 443 ? config.host : `${config.host}:${config.port}`,
  linkFor: (config) =>
    config.host === ""
      ? null
      : `https://${config.host}${config.port === 443 ? "" : `:${config.port}`}/`,
  uptimeMeans: t("tls.uptime"),
});

// ─── tcp ──────────────────────────────────────────────────────────────────────

export const tcpConfigSchema = z.object({
  host: monitorHostSchema,
  // Pas de port « par défaut » raisonnable au sens strict : on met 22 parce
  // que c'est le port qu'on veut surveiller le plus souvent sans HTTP devant,
  // et parce que c'est aussi celui qui illustre la bannière.
  port: z.number().int().min(1).max(65_535).default(22),
  /**
   * Bannière attendue, cherchée sans égard à la casse dans les premiers octets
   * que le service envoie **de lui-même**. C'est ce qui sépare « quelque chose
   * écoute » de « le bon service écoute ».
   */
  expectBanner: z.string().trim().min(1).max(200).nullable().default(null),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
});

export type TcpConfig = z.infer<typeof tcpConfigSchema>;

const tcpDefinition = (t: CatalogTranslate): MonitorTypeDefinition<TcpConfig> => ({
  type: "tcp",
  label: t("tcp.label"),
  /**
   * ── Qu'est-ce que « répondre » ? ──────────────────────────────────────────
   * La poignée TCP suffit à établir un fait, et un seul : quelque chose accepte
   * les connexions sur ce port. C'est déjà l'essentiel — un `ECONNREFUSED` sur
   * le 5432 d'une base, c'est le service arrêté ou le pare-feu refermé, et on
   * veut le savoir. Mais ce n'est **que** ça : un processus qui a gardé la
   * socket ouverte en étant incapable de servir accepte encore la poignée. La
   * poignée prouve l'écoute, pas la santé.
   *
   * D'où la bannière, en option. SMTP, SSH, FTP, IMAP, POP3 et Redis avec
   * `MOTD` parlent **les premiers** : ils annoncent qui ils sont avant qu'on
   * ouvre la bouche. Attendre `SSH-2.0` ou `220 ` fait donc passer la sonde de
   * « un port est ouvert » à « le bon service, vivant, écoute derrière ». C'est
   * une preuve qualitativement différente, et elle ne coûte qu'une lecture.
   *
   * ── Ce qu'on ne fait pas, et c'est un choix ───────────────────────────────
   * On **n'envoie jamais rien**. Pas de `EHLO`, pas de `PING`, pas même un
   * retour à la ligne. Deux raisons : une sonde est un constat, pas une action
   * — envoyer des octets à un service inconnu toutes les minutes, c'est le
   * solliciter, parfois le polluer (un `GET / HTTP/1.0` finit dans les journaux
   * d'accès, une commande SMTP dans les compteurs anti-abus) ; et un protocole
   * où le client parle d'abord (PostgreSQL, MySQL, HTTP) demanderait de savoir
   * *quel* protocole, ce qui ferait de cette sonde un client universel. Pour
   * ces services-là, la poignée nue est la bonne réponse, et le mot-clé HTTP
   * ou la sonde TLS font le reste quand on veut plus.
   *
   * Conséquence assumée : attendre une bannière d'un service qui n'en émet pas
   * coûte le délai d'expiration entier, à chaque mesure. Le message le dit.
   */
  description: t("tcp.description"),
  neverDoes: t("tcp.neverDoes"),
  schema: tcpConfigSchema,
  fields: [
    {
      key: "host",
      kind: "host",
      label: t("field.host.label"),
      placeholder: t("placeholder.domain"),
    },
    { key: "port", kind: "number", label: t("field.port.label"), min: 1, max: 65_535 },
    {
      key: "expectBanner",
      kind: "text",
      label: t("tcp.field.expectBanner.label"),
      optional: true,
      placeholder: t("tcp.field.expectBanner.placeholder"),
      hint: t("tcp.field.expectBanner.hint"),
    },
    {
      key: "timeoutMs",
      kind: "number",
      label: t("field.timeout.label"),
      min: 1_000,
      max: 30_000,
      step: 500,
      unit: "ms",
      advanced: true,
    },
  ],
  metrics: [
    {
      key: "connectMs",
      label: t("tcp.metric.connectMs"),
      kind: "duration-ms",
      primary: true,
    },
    { key: "address", label: t("metric.address"), kind: "text", primary: true },
    { key: "banner", label: t("tcp.metric.banner"), kind: "text" },
    { key: "bannerMs", label: t("tcp.metric.bannerMs"), kind: "duration-ms" },
  ],
  // Trente secondes, comme HTTP : une poignée TCP coûte moins qu'une requête
  // HTTP, et ce qu'elle observe — un service tombé — change aussi vite.
  minIntervalSeconds: 30,
  defaultIntervalSeconds: 60,
  defaults: { host: "", port: 22, expectBanner: null, timeoutMs: 10_000 },
  describeTarget: (config) => `${config.host}:${config.port}`,
  /**
   * `null`, et c'est délibéré : `https://hôte:25/` serait un lien cliquable qui
   * mène nulle part. Un port brut n'a pas d'URL, et en inventer une pour
   * remplir la case serait mentir à l'écran.
   */
  linkFor: () => null,
  uptimeMeans: t("tcp.uptime"),
});

// ─── dns ──────────────────────────────────────────────────────────────────────

/**
 * Un résolveur se déclare par son **adresse**, jamais par son nom : un nom
 * demanderait une résolution pour résoudre, et il faudrait bien la faire par
 * quelque chose.
 */
const dnsResolverSchema = z
  .string()
  .trim()
  .min(1)
  .max(45)
  .superRefine((value, ctx) => {
    if (classifyAddress(value) === null) {
      ctx.addIssue({
        code: "custom",
        ...invalid("monitor.resolverNotIp", { value }),
      });
      return;
    }
    // Le contrôle complet (liste d'autorisation) a lieu côté serveur : ici on
    // ne peut refuser que ce qu'aucune liste ne débloque.
    const verdict = checkNeverAllowable(value);
    if (!verdict.allowed) {
      ctx.addIssue({
        code: "custom",
        message: verdict.reason ?? "résolveur refusé",
      });
    }
  })
  .nullable()
  .default(null);

export const dnsConfigSchema = z
  .object({
    /**
     * Le nom interrogé. `kind: 'text'` et non `'host'` : on ne s'y **connecte**
     * pas, on pose une question à son sujet. Il passe quand même par
     * `monitorHostSchema` pour sa forme.
     */
    name: monitorHostSchema,
    recordType: dnsRecordTypeSchema.default("A"),
    /**
     * Les valeurs attendues, une par ligne (ou séparées par des virgules, sauf
     * pour TXT dont la donnée peut en contenir). **Vide = contrôle de présence** :
     * la sonde vérifie seulement que le nom rend au moins un enregistrement de
     * ce type.
     */
    expected: z.string().trim().max(4_096).default(""),
    match: dnsMatchModeSchema.default("exact"),
    resolver: dnsResolverSchema,
    timeoutMs: z.number().int().min(1_000).max(15_000).default(5_000),
  })
  .superRefine((config, ctx) => {
    // Une valeur attendue mal écrite est une fausse alerte garantie, tous les
    // quarts d'heure, jusqu'à ce que quelqu'un s'en aperçoive. On la refuse à
    // la saisie, avec le format en clair.
    for (const value of parseExpectedRecords(
      config.recordType,
      config.expected,
    )) {
      const problem = dnsRecordProblem(config.recordType, value);
      if (problem) {
        ctx.addIssue({
          code: "custom",
          path: ["expected"],
          ...invalid(problem.key, problem.vars),
        });
        return;
      }
    }
  });

export type DnsConfig = z.infer<typeof dnsConfigSchema>;

const dnsDefinition = (t: CatalogTranslate): MonitorTypeDefinition<DnsConfig> => ({
  type: "dns",
  label: t("dns.label"),
  /**
   * ── Comparer à quoi ? ─────────────────────────────────────────────────────
   * Deux régimes existent dans les services du marché, et ils ne servent pas la
   * même chose : *l'attendu déclaré* (« le A doit valoir 203.0.113.7 ») attrape
   * une erreur de configuration ; *la détection de changement* (« alerte si ça
   * bouge ») attrape un détournement.
   *
   * Ce type n'en implémente qu'**un**, l'attendu déclaré — et rend le second
   * gratuitement, ce qui évite de doubler la complexité. Comparer un ensemble
   * observé à un ensemble déclaré alerte sur toute suppression *et* sur tout
   * ajout : c'est déjà de la détection de changement, avec une référence
   * explicite.
   *
   * ── « Qui valide la nouvelle valeur ? », et pourquoi la réponse est bonne ──
   * Une référence apprise automatiquement — « je mémorise ce que je vois au
   * premier passage, j'alerte ensuite » — pose la question de la réadoption :
   * après une alerte, il faut bien qu'une nouvelle valeur devienne la référence.
   * Si le panel réadopte tout seul, il finit par **apprendre le détournement** —
   * la sonde crie une fois puis se tait, ce qui est exactement le contraire du
   * service rendu. Si l'humain réadopte, il le fait par un bouton… qui écrit la
   * nouvelle valeur quelque part.
   *
   * Ce « quelque part », ici, c'est le champ « valeurs attendues » lui-même. Un
   * humain modifie la sonde, ce qui passe par la même route, la même validation
   * et le même journal d'audit que tout le reste. Il n'y a donc pas de second
   * mécanisme de référence à écrire, pas de colonne à ajouter, et surtout pas de
   * réadoption silencieuse.
   *
   * Ce choix a aussi une raison de structure : l'abstraction `MonitorProbe` est
   * `run(config, ctx) → CheckResult`. Une sonde **ne peut rien écrire**. Une
   * référence apprise demanderait de rendre les sondes capables d'écrire dans
   * leur propre configuration — c'est-à-dire de percer l'abstraction pour un
   * seul type. Ça ne valait pas le prix.
   *
   * ── Quel résolveur ? ──────────────────────────────────────────────────────
   * Par défaut, celui du système — celui du conteneur worker. Il ne mesure pas
   * « ce que le monde voit » : il mesure ce que voit une machine du parc, avec
   * son cache, ses éventuelles vues internes (split-horizon) et son suffixe de
   * recherche. C'est un défaut assumé, pour deux raisons : c'est le chemin de
   * résolution qui compte réellement pour les machines qu'on exploite, et il
   * n'ajoute aucune dépendance envers un tiers.
   *
   * Déclarer un résolveur public (`1.1.1.1`, `9.9.9.9`) bascule la sonde vers
   * l'autre question — « qu'est-ce que le monde voit ? » — qui est la bonne pour
   * détecter un détournement, et qui contourne le cache local. C'est un champ,
   * pas un type à part, parce que c'est la même mesure vue d'un autre point.
   */
  description: t("dns.description"),
  neverDoes: t("dns.neverDoes"),
  schema: dnsConfigSchema as unknown as z.ZodType<DnsConfig>,
  fields: [
    {
      key: "name",
      kind: "text",
      label: t("dns.field.name.label"),
      placeholder: t("placeholder.domain"),
    },
    {
      key: "recordType",
      kind: "select",
      label: t("dns.field.recordType.label"),
      options: DNS_RECORD_TYPES_LIST.map((record) => ({
        value: record,
        label: t(`dns.record.${record}`),
      })),
    },
    {
      key: "expected",
      kind: "text",
      label: t("dns.field.expected.label"),
      optional: true,
      placeholder: t("dns.field.expected.placeholder"),
      hint: t("dns.field.expected.hint", {
        a: DNS_RECORD_TYPE_FORMATS.A,
        mx: DNS_RECORD_TYPE_FORMATS.MX,
        caa: DNS_RECORD_TYPE_FORMATS.CAA,
        srv: DNS_RECORD_TYPE_FORMATS.SRV,
      }),
    },
    {
      key: "match",
      kind: "select",
      label: t("field.matching.label"),
      options: [
        { value: "exact", label: t("dns.field.match.exact") },
        { value: "contains", label: t("dns.field.match.contains") },
      ] satisfies ReadonlyArray<{ value: DnsMatchMode; label: string }>,
      hint: t("dns.field.match.hint"),
    },
    {
      key: "resolver",
      kind: "host",
      label: t("dns.field.resolver.label"),
      optional: true,
      advanced: true,
      placeholder: t("dns.field.resolver.placeholder"),
      hint: t("dns.field.resolver.hint"),
    },
    {
      key: "timeoutMs",
      kind: "number",
      label: t("field.timeout.label"),
      min: 1_000,
      max: 15_000,
      step: 500,
      unit: "ms",
      advanced: true,
    },
  ],
  metrics: [
    {
      key: "resolveMs",
      label: t("dns.metric.resolveMs"),
      kind: "duration-ms",
      primary: true,
    },
    {
      key: "recordCount",
      label: t("dns.metric.recordCount"),
      kind: "number",
      primary: true,
    },
    { key: "values", label: t("dns.metric.values"), kind: "text" },
    { key: "missing", label: t("dns.metric.missing"), kind: "text" },
    { key: "unexpected", label: t("dns.metric.unexpected"), kind: "text" },
    { key: "resolver", label: t("dns.metric.resolver"), kind: "text" },
    { key: "minTtl", label: t("dns.metric.minTtl"), kind: "number" },
  ],
  /**
   * Cinq minutes au minimum, un quart d'heure par défaut.
   *
   * Deux bornes se rencontrent ici. Par le bas : 300 s est le TTL le plus court
   * qu'on configure couramment, et en deçà du TTL la réponse sort du cache du
   * résolveur — on paie une interrogation pour réapprendre ce qu'on savait déjà.
   * Interroger plus vite que le TTL, c'est mesurer son propre cache.
   *
   * Par le bas aussi, mais pour une autre raison : un résolveur public est une
   * ressource **partagée et gratuite**. Une requête HTTP vers son propre site,
   * on se la doit à soi-même ; une requête à `1.1.1.1` toutes les minutes, c'est
   * quelqu'un d'autre qui la paie. Cinquante sondes DNS à la minute feraient de
   * ce panel un nuisible pour un gain nul.
   *
   * Par le haut : un détournement de NS doit se voir dans l'heure, pas dans la
   * journée. Un quart d'heure par défaut tient les deux.
   */
  minIntervalSeconds: 300,
  defaultIntervalSeconds: 900,
  defaults: {
    name: "",
    recordType: "A" as DnsRecordType,
    expected: "",
    match: "exact" as DnsMatchMode,
    resolver: null,
    timeoutMs: 5_000,
  },
  describeTarget: (config) => `${config.recordType} ${config.name}`,
  /** Aucun lien : un enregistrement DNS n'est pas une page. */
  linkFor: () => null,
  uptimeMeans: t("dns.uptime"),
});

// ─── domain ───────────────────────────────────────────────────────────────────

/**
 * ── Quels TLD publient du RDAP, et pourquoi ce contrôle est ici ─────────────
 *
 * Tous les TLD ne servent pas de RDAP. Mesuré sur les fichiers de l'IANA du
 * 2026-09-09 : **1 200 des 1 438 TLD** en ont un. Les 238 absents se répartissent
 * en trois familles, et c'est ce qui rend le contrôle compact :
 *
 *   • 178 ccTLD à deux lettres — dont `.de`, `.io`, `.co`, `.eu`, `.ch`, `.it`,
 *     `.es`, `.be`, `.us`, `.jp` : aucune obligation ne pèse sur eux ;
 *   • 3 TLD de rôle : `arpa`, `edu`, `mil` ;
 *   • une partie des TLD internationalisés (`xn--…`).
 *
 * Tout le reste — les gTLD — en publie un : l'ICANN l'impose par contrat. Le
 * contrôle tient donc en une règle et une liste de 70 codes : *un TLD à deux
 * lettres hors liste, ou un TLD de rôle, n'a pas de RDAP ; sinon, oui.*
 *
 * **Pourquoi refuser à la création plutôt qu'échouer à l'exécution.** Une sonde
 * `domain` sur un `.io` ne peut rien constater, jamais. La laisser se créer,
 * c'est promettre une surveillance qui n'existera pas, puis afficher un voyant
 * rouge qui ment : l'absence de service RDAP n'est pas une panne du domaine.
 * Refuser tout de suite, avec le motif, est la seule réponse qui n'invente rien.
 *
 * **Ce que ça coûte.** La liste vieillit : un ccTLD qui ouvre un RDAP demain
 * sera refusé à tort jusqu'à ce qu'on ajoute deux lettres ici. C'est un défaut
 * assumé et réparable en une ligne — l'inverse (accepter puis mentir tous les
 * jours) ne l'est pas. Les `xn--` ne sont pas tranchés : trop peu utilisés pour
 * mériter 94 entrées de plus, on les laisse passer et l'exécution décidera.
 */
const CC_TLDS_WITH_RDAP: ReadonlySet<string> = new Set([
  "ad",
  "ai",
  "ar",
  "as",
  "au",
  "bm",
  "br",
  "ca",
  "cc",
  "cm",
  "cr",
  "cv",
  "cx",
  "cz",
  "ec",
  "fi",
  "fj",
  "fm",
  "fo",
  "fr",
  "gd",
  "gs",
  "gy",
  "hn",
  "ht",
  "id",
  "in",
  "is",
  "ke",
  "kg",
  "ky",
  "lb",
  "ly",
  "mg",
  "ml",
  "ms",
  "mu",
  "na",
  "nf",
  "ng",
  "nl",
  "no",
  "pg",
  "pl",
  "pm",
  "pn",
  "pw",
  "re",
  "rw",
  "sd",
  "sg",
  "si",
  "sn",
  "sr",
  "ss",
  "tf",
  "th",
  "to",
  "tv",
  "tw",
  "tz",
  "ua",
  "uk",
  "uz",
  "vg",
  "vi",
  "wf",
  "ye",
  "yt",
  "zm",
]);

/** TLD de rôle, hors du système commercial et sans RDAP. */
const TLDS_WITHOUT_RDAP: ReadonlySet<string> = new Set(["arpa", "edu", "mil"]);

/** Date de publication des fichiers IANA d'où sortent les deux listes ci-dessus. */
export const RDAP_TLD_KNOWLEDGE_DATE = "2026-09-09";

/**
 * `true` publie du RDAP, `false` n'en publie pas, `null` on ne tranche pas.
 * Seul `false` refuse une sonde : on ne bloque jamais sur une ignorance.
 */
export function tldPublishesRdap(tld: string): boolean | null {
  const value = tld.toLowerCase();
  if (TLDS_WITHOUT_RDAP.has(value)) return false;
  if (value.startsWith("xn--")) return null;
  if (value.length === 2) return CC_TLDS_WITH_RDAP.has(value);
  return true;
}

/** Le dernier label d'un nom de domaine, en minuscules. */
export function tldOf(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  return labels[labels.length - 1] ?? "";
}

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Un nom de domaine **enregistrable**, pas une URL et pas un hôte quelconque.
 *
 * On ne réécrit rien en silence : `www.exemple.fr` est accepté tel quel et le
 * registre répondra « inconnu », ce qui est un message plus utile qu'une
 * correction invisible. Deviner le domaine enregistrable demanderait la Public
 * Suffix List — 250 kio de données à tenir à jour pour retirer un `www.`.
 */
export const monitorDomainSchema = z
  .string()
  .trim()
  .min(3)
  .max(253)
  .superRefine((value, ctx) => {
    const raw = value.toLowerCase().replace(/\.$/, "");
    const refuse = (message: string): void =>
      void ctx.addIssue({ code: "custom", message });

    if (raw.includes("/") || raw.includes(":") || raw.includes(" ")) {
      return refuse("un nom de domaine, sans schéma, sans port et sans chemin");
    }
    const labels = raw.split(".");
    if (labels.length < 2)
      return refuse(`« ${raw} » n'est pas un nom de domaine complet`);
    if (labels.some((label) => !DOMAIN_LABEL.test(label))) {
      return refuse(`« ${raw} » n'est pas un nom de domaine valide`);
    }
    // Une adresse IP n'a pas de registre de noms — et son dernier label
    // passerait le contrôle de TLD sans qu'on s'en aperçoive.
    if (/^\d+$/.test(labels[labels.length - 1] ?? "")) {
      return refuse(
        "une adresse IP ne s’enregistre pas auprès d’un registre de noms",
      );
    }

    const tld = labels[labels.length - 1] ?? "";
    if (tldPublishesRdap(tld) === false) {
      return refuse(
        `le TLD « .${tld} » ne publie pas de service RDAP (liste IANA du ` +
          `${RDAP_TLD_KNOWLEDGE_DATE}) — cette sonde ne pourrait rien y constater`,
      );
    }
  })
  .transform((value) => value.toLowerCase().replace(/\.$/, ""));

export const DOMAIN_LOCK_MODES = ["off", "required"] as const;
export const domainLockModeSchema = z.enum(DOMAIN_LOCK_MODES);
export type DomainLockMode = z.infer<typeof domainLockModeSchema>;

export const domainConfigSchema = z.object({
  domain: monitorDomainSchema,
  /**
   * Préavis, en jours. Même parti pris que pour TLS : **en deçà, la sonde passe
   * en échec**. Voir `uptimeMeans` — et la note sur la machine à états, qui ne
   * connaît que sain / malade / injoignable et n'a pas de « en danger ».
   *
   * 30 jours par défaut, et non 21 comme pour un certificat : renouveler un
   * domaine peut demander de réveiller une carte bancaire expirée, un contact
   * de facturation parti, parfois un transfert. Un certificat se renouvelle en
   * une commande.
   */
  warnDays: z.number().int().min(1).max(365).default(30),
  /**
   * Registrar attendu. Facultatif, et c'est une **détection d'attaque**, pas un
   * confort : un domaine qu'on vous transfère sous le nez change de registrar,
   * et ça se voit ici avant que le trafic ne parte ailleurs. Comparé en
   * sous-chaîne tolérante — « OVH » reconnaît « OVH SAS ».
   */
  expectedRegistrar: z.string().trim().min(2).max(120).nullable().default(null),
  /**
   * Suffixe attendu d'au moins un serveur de noms — `ovh.net`, `cloudflare.com`.
   * Un suffixe plutôt qu'une liste : c'est la délégation qui compte, pas le
   * nombre de machines, et un registre en ajoute ou en retire sans prévenir.
   */
  expectedNameserverSuffix: z
    .string()
    .trim()
    .min(2)
    .max(253)
    .nullable()
    .default(null),
  /**
   * Exiger le verrou de transfert (`clientTransferProhibited`). Désactivé par
   * défaut : beaucoup de registres — `.fr` le premier — ne publient qu'un
   * statut `active` et feraient échouer la sonde pour un verrou qui existe
   * peut-être mais ne se lit pas.
   */
  transferLock: domainLockModeSchema.default("off"),
  /** Les registres ne sont pas des CDN : 15 s par défaut, et c'est parfois juste. */
  timeoutMs: z.number().int().min(2_000).max(30_000).default(15_000),
});

export type DomainConfig = z.infer<typeof domainConfigSchema>;

const domainDefinition = (
  t: CatalogTranslate,
): MonitorTypeDefinition<DomainConfig> => ({
  type: "domain",
  label: t("domain.label"),
  description: t("domain.description"),
  neverDoes: t("domain.neverDoes"),
  schema: domainConfigSchema,
  fields: [
    {
      key: "domain",
      kind: "host",
      label: t("domain.field.domain.label"),
      placeholder: t("placeholder.domain"),
      hint: t("domain.field.domain.hint"),
    },
    {
      key: "warnDays",
      kind: "number",
      label: t("field.warnDays.label"),
      min: 1,
      max: 365,
      unit: t("unit.days"),
      hint: t("domain.field.warnDays.hint"),
    },
    {
      key: "expectedRegistrar",
      kind: "text",
      label: t("domain.field.expectedRegistrar.label"),
      optional: true,
      advanced: true,
      placeholder: t("domain.field.expectedRegistrar.placeholder"),
      hint: t("domain.field.expectedRegistrar.hint"),
    },
    {
      key: "expectedNameserverSuffix",
      kind: "text",
      label: t("domain.field.nameserverSuffix.label"),
      optional: true,
      advanced: true,
      placeholder: t("domain.field.nameserverSuffix.placeholder"),
      hint: t("domain.field.nameserverSuffix.hint"),
    },
    {
      key: "transferLock",
      kind: "select",
      label: t("domain.field.transferLock.label"),
      advanced: true,
      options: [
        { value: "off", label: t("domain.field.transferLock.off") },
        { value: "required", label: t("domain.field.transferLock.required") },
      ],
      hint: t("domain.field.transferLock.hint"),
    },
    {
      key: "timeoutMs",
      kind: "number",
      label: t("field.timeout.label"),
      min: 2_000,
      max: 30_000,
      step: 500,
      unit: "ms",
      advanced: true,
    },
  ],
  metrics: [
    {
      key: "daysRemaining",
      label: t("metric.daysRemaining"),
      kind: "days",
      primary: true,
    },
    { key: "expiresOn", label: t("metric.expiresOn"), kind: "text", primary: true },
    { key: "registrar", label: t("domain.metric.registrar"), kind: "text" },
    { key: "nameservers", label: t("domain.metric.nameservers"), kind: "text" },
    { key: "eppStatus", label: t("domain.metric.eppStatus"), kind: "text" },
    { key: "registeredOn", label: t("domain.metric.registeredOn"), kind: "text" },
    { key: "lastChangedOn", label: t("domain.metric.lastChangedOn"), kind: "text" },
    { key: "rdapServer", label: t("domain.metric.rdapServer"), kind: "text" },
    { key: "latencyMs", label: t("metric.latencyMs"), kind: "duration-ms" },
  ],
  // Six heures au minimum. Un domaine n'expire pas entre deux minutes, et un
  // registre est un service public gratuit : l'interroger plus souvent, c'est
  // faire du panel un nuisible sans rien apprendre de plus.
  minIntervalSeconds: 6 * 3_600,
  defaultIntervalSeconds: 86_400,
  defaults: {
    domain: "",
    warnDays: 30,
    expectedRegistrar: null,
    expectedNameserverSuffix: null,
    transferLock: "off",
    timeoutMs: 15_000,
  },
  describeTarget: (config) => config.domain,
  // Pas de lien : un domaine surveillé pour son expiration n'a pas forcément de
  // site, ni même d'adresse. `linkFor` sert aussi de cible au contrôle SSRF de
  // création (`assertConfigAllowed`) ; rendre une URL ici obligerait le domaine
  // à résoudre publiquement pour qu'on accepte de surveiller sa date de fin.
  linkFor: () => null,
  uptimeMeans: t("domain.uptime"),
});

// ─── registre ─────────────────────────────────────────────────────────────────

/**
 * Une entrée par type. Le catalogue est typé de façon opaque côté consommateur :
 * personne d'autre que l'implémentation n'a besoin du type exact de la config,
 * et c'est précisément ce qui permet à l'écran de ne connaître aucun type.
 */
function buildCatalog(
  t: CatalogTranslate,
): Record<MonitorType, MonitorTypeDefinition<never>> {
  return {
    http: httpDefinition(t) as unknown as MonitorTypeDefinition<never>,
    keyword: keywordDefinition(t) as unknown as MonitorTypeDefinition<never>,
    tls: tlsDefinition(t) as unknown as MonitorTypeDefinition<never>,
    tcp: tcpDefinition(t) as unknown as MonitorTypeDefinition<never>,
    dns: dnsDefinition(t) as unknown as MonitorTypeDefinition<never>,
    domain: domainDefinition(t) as unknown as MonitorTypeDefinition<never>,
  };
}

const CATALOGS = new Map<
  UiLanguage,
  Record<MonitorType, MonitorTypeDefinition<never>>
>();

/**
 * Le catalogue dans une langue, construit une fois par langue demandée.
 *
 * Les schémas Zod, eux, ne sont pas dupliqués : ce sont les mêmes objets de
 * module dans les deux catalogues. Seuls les libellés diffèrent — ce qui est
 * exactement ce qu'on voulait dire en séparant les mots des données.
 */
function catalogFor(
  language: UiLanguage,
): Record<MonitorType, MonitorTypeDefinition<never>> {
  const cached = CATALOGS.get(language);
  if (cached) return cached;
  const built = buildCatalog(translator(monitorCatalogCopy, language));
  CATALOGS.set(language, built);
  return built;
}

export const MONITOR_TYPES: Record<
  MonitorType,
  MonitorTypeDefinition<never>
> = catalogFor("fr");

export type AnyMonitorTypeDefinition = {
  type: MonitorType;
  label: string;
  description: string;
  neverDoes: string;
  schema: z.ZodType<unknown>;
  fields: readonly ConfigField[];
  metrics: readonly MetricDescriptor[];
  minIntervalSeconds: number;
  defaultIntervalSeconds: number;
  defaults: unknown;
  describeTarget: (config: never) => string;
  linkFor: (config: never) => string | null;
  uptimeMeans: string;
};

/**
 * La définition d'un type, dans une langue.
 *
 * Le défaut reste le français : le worker et la base y lisent un schéma, une
 * cadence minimale ou un libellé de journal, et n'ont pas de langue d'instance
 * à offrir. Le panel, lui, passe la sienne.
 */
export function monitorTypeDefinition(
  type: MonitorType,
  language: UiLanguage = "fr",
): AnyMonitorTypeDefinition {
  return catalogFor(language)[type] as unknown as AnyMonitorTypeDefinition;
}

/** Valide la configuration d'une sonde contre le schéma de **son** type. */
export function parseMonitorConfig(
  type: MonitorType,
  config: unknown,
): unknown {
  return monitorTypeDefinition(type).schema.parse(config);
}

export function safeParseMonitorConfig(
  type: MonitorType,
  config: unknown,
): { ok: true; config: unknown } | { ok: false; error: z.ZodError } {
  const parsed = monitorTypeDefinition(type).schema.safeParse(config);
  return parsed.success
    ? { ok: true, config: parsed.data }
    : { ok: false, error: parsed.error };
}

/** La cible d'une sonde, en une ligne. Jamais un `switch` chez l'appelant. */
export function describeMonitorTarget(
  type: MonitorType,
  config: unknown,
  language: UiLanguage = "fr",
): string {
  const definition = monitorTypeDefinition(type, language);
  const parsed = definition.schema.safeParse(config);
  if (!parsed.success) {
    return translator(monitorCatalogCopy, language)("target.unreadable");
  }
  return definition.describeTarget(parsed.data as never);
}

export function monitorTargetLink(
  type: MonitorType,
  config: unknown,
): string | null {
  const definition = monitorTypeDefinition(type);
  const parsed = definition.schema.safeParse(config);
  if (!parsed.success) return null;
  return definition.linkFor(parsed.data as never);
}

export function isMonitorType(value: string): value is MonitorType {
  return (MONITOR_TYPES_LIST as readonly string[]).includes(value);
}

// ─── contrôle SSRF à la création, sans switch et sans réseau ──────────────────

export type MonitorTargetVerdict =
  | { allowed: true }
  | { allowed: false; field: string; refusal: SsrfRefusal; reason: string };

/**
 * Refuse, **au moment d'enregistrer la sonde**, toute cible écrite en adresse
 * littérale interdite.
 *
 * Pourquoi ici et pas dans chaque schéma : le catalogue sait déjà quels champs
 * sont des endpoints, puisqu'il les déclare en `kind: 'host'` ou `kind: 'url'`
 * pour que l'écran les affiche. On réutilise ce marquage plutôt que d'ajouter
 * une liste parallèle à tenir à jour — un type qui arrive plus tard est couvert
 * dès qu'il déclare ses champs, sans rien ajouter ici. Il n'y a donc aucun
 * `if (type === …)`.
 *
 * Pourquoi pas dans le schéma Zod du type : la liste d'autorisation vient de
 * `MONITOR_ALLOWED_CIDRS`, donc de l'environnement du serveur. Le catalogue est
 * importé par des composants client, où cet environnement n'existe pas — un
 * schéma qui le lirait refuserait dans le navigateur une plage que le serveur
 * accepte. Le schéma s'en tient donc à ce qui est vrai partout (les catégories
 * qu'aucune liste ne débloque, via `checkHostname`) et l'appelant serveur
 * complète par cette fonction.
 *
 * Ce qu'elle **ne** fait **pas** : résoudre. Un nom n'est jugé qu'au moment de
 * sonder, par `resolveGuarded()`, qui contrôle toutes ses adresses. Une
 * validation ne fait pas de requête réseau, et de toute façon le contrôle qui
 * compte est celui d'avant la connexion — la fenêtre de rebinding se ferme là,
 * pas ici.
 */
export function checkMonitorTargetLiterals(
  type: MonitorType,
  config: unknown,
  allowlist: readonly Cidr[],
): MonitorTargetVerdict {
  const definition = monitorTypeDefinition(type);
  const parsed = definition.schema.safeParse(config);
  // Une configuration illisible est refusée par ailleurs, avec un meilleur
  // message ; ce n'est pas à la garde de le dire.
  if (!parsed.success) return { allowed: true };
  const record = parsed.data as Record<string, unknown>;

  for (const field of definition.fields) {
    if (field.kind !== "host" && field.kind !== "url") continue;
    const raw = record[field.key];
    if (typeof raw !== "string" || raw.trim() === "") continue;

    let host = raw.trim();
    if (field.kind === "url") {
      try {
        host = new URL(host).hostname;
      } catch {
        continue;
      }
    }
    host = host.replace(/^\[|\]$/g, "");

    // Un nom : rien à dire ici, tout se joue à la résolution.
    if (classifyAddress(host) === null) continue;

    const verdict = checkAddress(host, allowlist);
    if (!verdict.allowed) {
      return {
        allowed: false,
        field: field.key,
        refusal: verdict.refusal,
        reason: verdict.reason,
      };
    }
  }

  return { allowed: true };
}

/** Bornes absolues de cadence, tous types confondus — ce que la base accepte. */
export const MONITOR_INTERVAL_FLOOR_SECONDS = 30;
export const MONITOR_INTERVAL_CEILING_SECONDS = 30 * 86_400;
