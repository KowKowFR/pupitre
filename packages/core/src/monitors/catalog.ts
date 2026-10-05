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
 * Catalog of probe types.
 *
 * ── The shape, and why this one ─────────────────────────────────────────────
 * Monitoring a site is not one thing but six: HTTP availability, a keyword in
 * the page, TLS certificate, DNS records, domain expiry, content fingerprint.
 * They are not six features — they are **one abstraction and six
 * implementations**, exactly the shape of `Scanner` and `DeploymentDriver`.
 *
 * Hence this catalog, on the `ai/catalog.ts` pattern: a table of **data** that
 * describes, for each type, its configuration schema, the fields the screen
 * must show, the measurements it returns, and its minimum interval. The UI is
 * built from this table; there is no `if (type === 'http')` anywhere.
 *
 * A type's own configuration lives in a **JSONB** column validated by the
 * type's Zod schema — not in columns dedicated to HTTP. The `monitors` table
 * only carries what is common: the type, the interval, the state, the
 * confirmation thresholds, the optional link to an application.
 *
 * ── Two consequences, handled here ──────────────────────────────────────────
 *
 * 1. **The interval depends on the type.** An HTTP probe every minute is
 *    reasonable; querying a domain's expiry every minute is not — a domain does
 *    not expire between two minutes, and it would harass the registries for
 *    nothing. Each type therefore carries its `minIntervalSeconds`, and
 *    validation enforces it.
 *
 * 2. **The measurements depend on the type.** An HTTP probe returns a latency
 *    and a code; a TLS probe returns days left and an issuer. Nothing is forced
 *    into HTTP columns: the result carries a structured measurement space
 *    (`metrics`), and the catalog tells the screen how to show it.
 *
 * ── Adding a type ───────────────────────────────────────────────────────────
 * An entry here, an implementation under `@pupitre/core/probe`, a line in the
 * probe registry. Neither the table, nor the runner, nor the routes, nor the
 * screen change. `monitors.type` is deliberately `text` and not a Postgres
 * enum: an enum would add a migration to this list, and that is precisely the
 * surgery we want to avoid. The vocabulary stays closed — it is here, and Zod
 * enforces it on every input.
 *
 * ── The content fingerprint, and why it is not here ─────────────────────────
 * Of the six types announced above, four are written. The sixth — alerting
 * when a page **changes** — is not a variant of the keyword, despite the
 * resemblance: a keyword assertion is *memoryless* (a config, a response, a
 * verdict), whereas a fingerprint only makes sense compared with the previous
 * one. But `MonitorProbe.run(config, ctx)` does not receive the previous state,
 * deliberately: it is what makes a probe replayable and testable without a
 * database.
 *
 * Shipping it "halfway" would take two shapes, both bad: pinning a fingerprint
 * in the configuration, which nobody can fill in by hand; or publishing a
 * fingerprint as a mere measurement, which would flicker with every CSRF token
 * and alert on nothing. Doing it properly requires widening the probes'
 * contract — a decision to make, not a side effect of another type.
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

// ─── field descriptions, so the screen builds itself ──────────────────────────

export type ConfigFieldBase = {
  key: string;
  label: string;
  hint?: string;
  /** An optional field can be left empty; its value is then `null`. */
  optional?: boolean;
  /** A fine-tuning field, folded behind "Advanced options". */
  advanced?: boolean;
};

/**
 * `url` and `host` are not input decoration: they **declare that the worker
 * will open a socket to this value**. It is this marking, and it alone, that
 * triggers the SSRF address check (`checkMonitorTargetLiterals`), without
 * anybody having to keep a list of "which fields are targets".
 *
 * A corollary, and it matters for the DNS probe: the name we **query** is not a
 * connection target — we never connect to it, we ask a question about it. It is
 * therefore declared as `text`, and it is the **resolver** that carries the
 * `host`, because it is the one, and the only one, reached over the network.
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

/** How to show a measurement. The screen only knows these shapes. */
export type MetricDescriptor = {
  key: string;
  label: string;
  kind: "duration-ms" | "days" | "number" | "text" | "http-status";
  /** Highlighted in the list, next to the state. */
  primary?: boolean;
};

export type MonitorTypeDefinition<Config> = {
  type: MonitorType;
  label: string;
  /** What this type observes, in one sentence. */
  description: string;
  /** What it does **not** observe — shown on screen, on purpose. */
  neverDoes: string;
  schema: z.ZodType<Config>;
  fields: readonly ConfigField[];
  metrics: readonly MetricDescriptor[];
  /**
   * Minimum interval, in seconds. Per type because it is a property of the type:
   * what it costs at the other end, and how fast what it observes can change.
   */
  minIntervalSeconds: number;
  defaultIntervalSeconds: number;
  /** Starting values of the form. */
  defaults: Config;
  /** The target, in one line, for a list. */
  describeTarget: (config: Config) => string;
  /** Clickable link to the target, when it makes sense. */
  linkFor: (config: Config) => string | null;
  /** How this type's availability rate reads. */
  uptimeMeans: string;
};

// ─── the catalog's words ──────────────────────────────────────────────────────

/**
 * Everything the catalog **displays**, and nothing else.
 *
 * Enumeration keys (`http`, `lenient`, `A`), Zod schemas, bounds and starting
 * values stay below: they are data, they have no language. What appears on
 * screen — a type's name, a field's label, input help, a measurement's name —
 * is here, once, and the compiler refuses an incomplete translation.
 *
 * Labels shared by several types ("Host", "Expected code", "Response time") are
 * only written once, under a neutral prefix: two types that show the same word
 * must not be able to give it two different translations.
 */
const fr = {
  // ── Shared labels ───────────────────────────────────────────────────────
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
  /** Rendered when the configuration cannot be read — see `describeMonitorTarget`. */
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
   * Keyword to find in the body. An option of the HTTP probe, and not a separate
   * type: it is the same request, we simply look at one more thing.
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
  // Thirty seconds: below that, a probe costs the worker more than it brings,
  // and the time series doubles to detect an outage three seconds earlier.
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
 * How we compare. Two named intentions rather than three orthogonal switches
 * (case, accents, spaces) that nobody combines correctly.
 */
export const KEYWORD_MATCHINGS = ["lenient", "strict"] as const;
export const keywordMatchingSchema = z.enum(KEYWORD_MATCHINGS);
export type KeywordMatching = z.infer<typeof keywordMatchingSchema>;

/** What we search in: the response as is, or an approximation of the text. */
export const KEYWORD_SCOPES = ["raw", "text"] as const;
export const keywordScopeSchema = z.enum(KEYWORD_SCOPES);
export type KeywordScope = z.infer<typeof keywordScopeSchema>;

/** Read cap, in KiB. See `maxKib` for the reasoning. */
export const KEYWORD_MIN_KIB = 16;
export const KEYWORD_MAX_KIB = 2048;

export const keywordConfigSchema = z
  .object({
    url: monitorUrlSchema,
    /**
     * **Presence and absence, both.** They are two real and opposite needs: "the
     * sign-in page must say *Sign in*" proves the application renders; "it must not
     * say *Error 500*" catches the application error page that proudly answers 200.
     * Refusing one of the two would force probing the same page twice for two
     * halves of the same question.
     *
     * One keyword per field, not a list. Five keywords in one probe give a single
     * red light; five probes say which one failed. The day a list is needed, it will
     * require a field shape the screen cannot render yet — that is, a screen change,
     * hence a decision, not a side effect.
     */
    mustContain: z.string().trim().min(1).max(200).nullable().default(null),
    mustNotContain: z.string().trim().min(1).max(200).nullable().default(null),
    matching: keywordMatchingSchema.default("lenient"),
    scope: keywordScopeSchema.default("raw"),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    /**
     * What we accept to download to look for a word in it.
     *
     * Both bounds are real problems: pulling 40 MB every minute for a word is an
     * absurd load; stopping at 64 KiB misses a footer. 512 KiB by default very
     * comfortably covers a cleanly served HTML page, and the probe **says** when it
     * cut — a keyword "absent" from a truncated response is not the same
     * information as a keyword absent from a complete response, and the message does
     * not confuse them.
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
  // Same interval as HTTP: it is the same request, with a bit more reading. What
  // costs is the number of requests, not what is done with them.
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
   * Name presented in SNI, when it differs from the host reached. Useful to check
   * the certificate of a vhost behind a shared address.
   */
  servername: z.string().trim().min(1).max(253).nullable().default(null),
  /**
   * Notice, in days. It **is not** a mere warning: below it, the probe fails. A
   * certificate probe is only useful if it alerts *before* the outage; waiting for
   * the expiry would amount to observing the fire. A TLS probe's availability rate
   * therefore reads "share of the time the certificate was valid **and not near
   * its end**".
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
  // One hour: a certificate does not change faster, and each measurement is a
  // full TLS handshake at someone else's place.
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
  // No reasonable "default" port in the strict sense: we put 22 because it is the
  // port most often worth watching without HTTP in front, and because it is also
  // the one that illustrates the banner.
  port: z.number().int().min(1).max(65_535).default(22),
  /**
   * Expected banner, looked for case-insensitively in the first bytes the service
   * sends **by itself**. It is what separates "something listens" from "the right
   * service listens".
   */
  expectBanner: z.string().trim().min(1).max(200).nullable().default(null),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
});

export type TcpConfig = z.infer<typeof tcpConfigSchema>;

const tcpDefinition = (t: CatalogTranslate): MonitorTypeDefinition<TcpConfig> => ({
  type: "tcp",
  label: t("tcp.label"),
  /**
   * ── What is "answering"? ─────────────────────────────────────────────────────
   * The TCP handshake is enough to establish a fact, and only one: something
   * accepts connections on this port. That is already the essential — an
   * `ECONNREFUSED` on a database's 5432 means the service is stopped or the
   * firewall closed, and we want to know. But it is **only** that: a process that
   * kept the socket open while unable to serve still accepts the handshake. The
   * handshake proves listening, not health.
   *
   * Hence the banner, as an option. SMTP, SSH, FTP, IMAP, POP3 and Redis with
   * `MOTD` speak **first**: they announce who they are before anyone opens their
   * mouth. Expecting `SSH-2.0` or `220 ` therefore takes the probe from "a port is
   * open" to "the right service, alive, listens behind it". It is a qualitatively
   * different proof, and it only costs a read.
   *
   * ── What we do not do, and it is a choice ───────────────────────────────────
   * We **never send anything**. No `EHLO`, no `PING`, not even a newline. Two
   * reasons: a probe is an observation, not an action — sending bytes to an
   * unknown service every minute is soliciting it, sometimes polluting it (a
   * `GET / HTTP/1.0` ends up in the access logs, an SMTP command in the anti-abuse
   * counters); and a protocol where the client speaks first (PostgreSQL, MySQL,
   * HTTP) would require knowing *which* protocol, which would make this probe a
   * universal client. For those services, the bare handshake is the right answer,
   * and the HTTP keyword or the TLS probe do the rest when more is wanted.
   *
   * An accepted consequence: expecting a banner from a service that emits none
   * costs the whole timeout, at every measurement. The message says so.
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
  // Thirty seconds, like HTTP: a TCP handshake costs less than an HTTP request,
  // and what it observes — a service down — changes just as fast.
  minIntervalSeconds: 30,
  defaultIntervalSeconds: 60,
  defaults: { host: "", port: 22, expectBanner: null, timeoutMs: 10_000 },
  describeTarget: (config) => `${config.host}:${config.port}`,
  /**
   * `null`, deliberately: `https://host:25/` would be a clickable link that leads
   * nowhere. A raw port has no URL, and making one up to fill the box would be
   * lying on screen.
   */
  linkFor: () => null,
  uptimeMeans: t("tcp.uptime"),
});

// ─── dns ──────────────────────────────────────────────────────────────────────

/**
 * A resolver is declared by its **address**, never by its name: a name would
 * require a resolution to resolve, and it would have to be done by something.
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
    // The full check (allowlist) happens on the server side: here we can only
    // refuse what no list unlocks.
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
     * The name queried. `kind: 'text'` and not `'host'`: we do not **connect** to
     * it, we ask a question about it. It still goes through `monitorHostSchema` for
     * its shape.
     */
    name: monitorHostSchema,
    recordType: dnsRecordTypeSchema.default("A"),
    /**
     * The expected values, one per line (or comma-separated, except for TXT, whose
     * data can contain commas). **Empty = presence check**: the probe only checks
     * that the name returns at least one record of this type.
     */
    expected: z.string().trim().max(4_096).default(""),
    match: dnsMatchModeSchema.default("exact"),
    resolver: dnsResolverSchema,
    timeoutMs: z.number().int().min(1_000).max(15_000).default(5_000),
  })
  .superRefine((config, ctx) => {
    // A badly written expected value is a guaranteed false alert, every quarter of
    // an hour, until someone notices. We refuse it on input, with the format spelled
    // out.
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
   * ── Compare with what? ───────────────────────────────────────────────────────
   * Two regimes exist in the services on the market, and they do not serve the
   * same thing: *the declared expectation* ("the A must be 203.0.113.7") catches a
   * configuration error; *change detection* ("alert if it moves") catches a
   * hijacking.
   *
   * This type implements only **one**, the declared expectation — and gets the
   * second for free, which avoids doubling the complexity. Comparing an observed
   * set with a declared set alerts on every removal *and* every addition: it is
   * already change detection, with an explicit reference.
   *
   * ── "Who approves the new value?", and why the answer is right ──────────────
   * A reference learned automatically — "I memorize what I see on the first pass,
   * then alert" — raises the question of re-adoption: after an alert, a new value
   * has to become the reference. If the panel re-adopts by itself, it ends up
   * **learning the hijacking** — the probe shouts once then goes quiet, exactly
   * the opposite of the service rendered. If the human re-adopts, they do it
   * through a button… which writes the new value somewhere.
   *
   * That "somewhere", here, is the "expected values" field itself. A human edits
   * the probe, which goes through the same route, the same validation and the
   * same audit log as everything else. There is therefore no second reference
   * mechanism to write, no column to add, and above all no silent re-adoption.
   *
   * This choice also has a structural reason: the `MonitorProbe` abstraction is
   * `run(config, ctx) → CheckResult`. A probe **cannot write anything**. A learned
   * reference would require making probes able to write into their own
   * configuration — that is, piercing the abstraction for a single type. It was
   * not worth the price.
   *
   * ── Which resolver? ──────────────────────────────────────────────────────────
   * By default, the system's — the worker container's. It does not measure "what
   * the world sees": it measures what a machine of the fleet sees, with its
   * cache, its possible internal views (split-horizon) and its search suffix. It
   * is an accepted default, for two reasons: it is the resolution path that really
   * matters for the machines we operate, and it adds no dependency on a third
   * party.
   *
   * Declaring a public resolver (`1.1.1.1`, `9.9.9.9`) switches the probe to the
   * other question — "what does the world see?" — which is the right one to detect
   * a hijacking, and which bypasses the local cache. It is a field, not a separate
   * type, because it is the same measurement seen from another point.
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
   * Five minutes at least, a quarter of an hour by default.
   *
   * Two bounds meet here. From below: 300 s is the shortest TTL commonly
   * configured, and under the TTL the answer comes from the resolver's cache — we
   * pay a query to learn again what we already knew. Querying faster than the TTL
   * is measuring one's own cache.
   *
   * From below too, but for another reason: a public resolver is a **shared and
   * free** resource. An HTTP request to one's own site is owed to oneself; a
   * request to `1.1.1.1` every minute is paid by someone else. Fifty DNS probes a
   * minute would make this panel a nuisance for zero gain.
   *
   * From above: an NS hijacking must show within the hour, not within the day. A
   * quarter of an hour by default holds both.
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
  /** No link: a DNS record is not a page. */
  linkFor: () => null,
  uptimeMeans: t("dns.uptime"),
});

// ─── domain ───────────────────────────────────────────────────────────────────

/**
 * ── Which TLDs publish RDAP, and why this check is here ─────────────────────
 *
 * Not every TLD serves RDAP. Measured on IANA's files of 2026-09-09: **1,200 of
 * the 1,438 TLDs** have one. The 238 without fall into three families, which is
 * what makes the check compact:
 *
 *   • 178 two-letter ccTLDs — including `.de`, `.io`, `.co`, `.eu`, `.ch`,
 *     `.it`, `.es`, `.be`, `.us`, `.jp`: no obligation weighs on them;
 *   • 3 role TLDs: `arpa`, `edu`, `mil`;
 *   • part of the internationalized TLDs (`xn--…`).
 *
 * Everything else — the gTLDs — publishes one: ICANN requires it by contract.
 * The check therefore fits in one rule and a list of 70 codes: *a two-letter
 * TLD outside the list, or a role TLD, has no RDAP; otherwise, it does.*
 *
 * **Why refuse at creation rather than fail at execution.** A `domain` probe on
 * a `.io` can never observe anything. Letting it be created is promising
 * monitoring that will not exist, then showing a red light that lies: the
 * absence of an RDAP service is not an outage of the domain. Refusing right
 * away, with the reason, is the only answer that makes nothing up.
 *
 * **What it costs.** The list ages: a ccTLD that opens an RDAP tomorrow will be
 * wrongly refused until two letters are added here. It is an accepted defect,
 * fixable in one line — the reverse (accepting then lying every day) is not.
 * The `xn--` ones are not decided: too rarely used to deserve 94 more entries,
 * we let them through and execution will decide.
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

/** Role TLDs, outside the commercial system and without RDAP. */
const TLDS_WITHOUT_RDAP: ReadonlySet<string> = new Set(["arpa", "edu", "mil"]);

/** Publication date of the IANA files both lists above come from. */
export const RDAP_TLD_KNOWLEDGE_DATE = "2026-09-09";

/**
 * `true` publishes RDAP, `false` does not, `null` we do not decide. Only
 * `false` refuses a probe: we never block on ignorance.
 */
export function tldPublishesRdap(tld: string): boolean | null {
  const value = tld.toLowerCase();
  if (TLDS_WITHOUT_RDAP.has(value)) return false;
  if (value.startsWith("xn--")) return null;
  if (value.length === 2) return CC_TLDS_WITH_RDAP.has(value);
  return true;
}

/** The last label of a domain name, lowercase. */
export function tldOf(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  return labels[labels.length - 1] ?? "";
}

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A **registrable** domain name, not a URL and not any host.
 *
 * Nothing is silently rewritten: `www.example.com` is accepted as is and the
 * registry will answer "unknown", which is a more useful message than an
 * invisible correction. Guessing the registrable domain would require the
 * Public Suffix List — 250 KiB of data to keep up to date to strip a `www.`.
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
    // An IP address has no name registry — and its last label would pass the TLD
    // check without anyone noticing.
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
   * Notice, in days. The same stance as for TLS: **below it, the probe fails**.
   * See `uptimeMeans` — and the note on the state machine, which only knows
   * healthy / unhealthy / unreachable and has no "at risk".
   *
   * 30 days by default, and not 21 as for a certificate: renewing a domain may
   * require reviving an expired bank card, a billing contact who left, sometimes a
   * transfer. A certificate renews in one command.
   */
  warnDays: z.number().int().min(1).max(365).default(30),
  /**
   * Expected registrar. Optional, and it is **attack detection**, not convenience:
   * a domain transferred away from under you changes registrar, and it shows here
   * before the traffic goes elsewhere. Compared as a tolerant substring — "OVH"
   * recognizes "OVH SAS".
   */
  expectedRegistrar: z.string().trim().min(2).max(120).nullable().default(null),
  /**
   * Expected suffix of at least one name server — `ovh.net`, `cloudflare.com`. A
   * suffix rather than a list: the delegation is what counts, not the number of
   * machines, and a registry adds or removes some without warning.
   */
  expectedNameserverSuffix: z
    .string()
    .trim()
    .min(2)
    .max(253)
    .nullable()
    .default(null),
  /**
   * Require the transfer lock (`clientTransferProhibited`). Off by default: many
   * registries — `.fr` first — only publish an `active` status and would make the
   * probe fail for a lock that may exist but cannot be read.
   */
  transferLock: domainLockModeSchema.default("off"),
  /** Registries are not CDNs: 15 s by default, and it is sometimes tight. */
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
  // Six hours at least. A domain does not expire between two minutes, and a
  // registry is a free public service: querying it more often makes the panel a
  // nuisance without learning anything more.
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
  // No link: a domain watched for its expiry does not necessarily have a site, or
  // even an address. `linkFor` also serves as the target of the creation SSRF
  // check (`assertConfigAllowed`); returning a URL here would force the domain to
  // resolve publicly before we accept to watch its end date.
  linkFor: () => null,
  uptimeMeans: t("domain.uptime"),
});

// ─── registry ─────────────────────────────────────────────────────────────────

/**
 * One entry per type. The catalog is typed opaquely on the consumer side:
 * nobody but the implementation needs the config's exact type, and that is
 * precisely what lets the screen know no type.
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
 * The catalog in one language, built once per requested language.
 *
 * The Zod schemas are not duplicated: they are the same module objects in both
 * catalogs. Only the labels differ — which is exactly what we meant by
 * separating words from data.
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
 * A type's definition, in one language: the panel passes its screen's, the
 * worker the instance's.
 *
 * The minimum interval is per type because it is a property of the type: what it
 * costs at the other end, and how fast what it observes can change. An HTTP probe
 * every minute is reasonable; querying a domain registry every minute would make
 * the panel a nuisance.
 */
export function monitorTypeDefinition(
  type: MonitorType,
  language: UiLanguage,
): AnyMonitorTypeDefinition {
  return catalogFor(language)[type] as unknown as AnyMonitorTypeDefinition;
}

/**
 * A type's definition in the source language, for what reads its structure — a
 * schema, a link —, not its words. The schemas' complaints stay in French there:
 * the screen finds them again by their sentence (`issueMessage()`).
 */
function sourceDefinition(type: MonitorType): AnyMonitorTypeDefinition {
  return MONITOR_TYPES[type] as unknown as AnyMonitorTypeDefinition;
}

/** Validates a probe's configuration against **its** type's schema. */
export function parseMonitorConfig(
  type: MonitorType,
  config: unknown,
): unknown {
  return sourceDefinition(type).schema.parse(config);
}

export function safeParseMonitorConfig(
  type: MonitorType,
  config: unknown,
): { ok: true; config: unknown } | { ok: false; error: z.ZodError } {
  const parsed = sourceDefinition(type).schema.safeParse(config);
  return parsed.success
    ? { ok: true, config: parsed.data }
    : { ok: false, error: parsed.error };
}

/** A probe's target, in one line. Never a `switch` in the caller. */
export function describeMonitorTarget(
  type: MonitorType,
  config: unknown,
  language: UiLanguage,
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
  const definition = sourceDefinition(type);
  const parsed = definition.schema.safeParse(config);
  if (!parsed.success) return null;
  return definition.linkFor(parsed.data as never);
}

export function isMonitorType(value: string): value is MonitorType {
  return (MONITOR_TYPES_LIST as readonly string[]).includes(value);
}

// ─── SSRF check at creation, without a switch and without network ─────────────

export type MonitorTargetVerdict =
  | { allowed: true }
  | { allowed: false; field: string; refusal: SsrfRefusal; reason: string };

/**
 * Refuses, **when the probe is saved**, any target written as a forbidden
 * literal address.
 *
 * Why here and not in each schema: the catalog already knows which fields are
 * endpoints, since it declares them as `kind: 'host'` or `kind: 'url'` for the
 * screen to show them. We reuse this marking rather than add a parallel list to
 * keep up to date — a type that comes later is covered as soon as it declares
 * its fields, without adding anything here. There is therefore no
 * `if (type === …)`.
 *
 * Why not in the type's Zod schema: the allowlist comes from
 * `MONITOR_ALLOWED_CIDRS`, hence from the server's environment. The catalog is
 * imported by client components, where that environment does not exist — a
 * schema reading it would refuse in the browser a range the server accepts. The
 * schema therefore sticks to what is true everywhere (the categories no list
 * unlocks, through `checkHostname`) and the server caller completes with this
 * function.
 *
 * What it does **not** do: resolve. A name is only judged at probe time, by
 * `resolveGuarded()`, which checks all its addresses. A validation makes no
 * network request, and anyway the check that matters is the one before the
 * connection — the rebinding window closes there, not here.
 */
export function checkMonitorTargetLiterals(
  type: MonitorType,
  config: unknown,
  allowlist: readonly Cidr[],
): MonitorTargetVerdict {
  const definition = sourceDefinition(type);
  const parsed = definition.schema.safeParse(config);
  // An unreadable configuration is refused elsewhere, with a better message; it
  // is not the guard's job to say it.
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

    // A name: nothing to say here, everything happens at resolution.
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

/** Absolute interval bounds, all types together — what the database accepts. */
export const MONITOR_INTERVAL_FLOOR_SECONDS = 30;
export const MONITOR_INTERVAL_CEILING_SECONDS = 30 * 86_400;
