import { z } from 'zod';

/**
 * Captures d'écran d'incident — le vocabulaire, les bornes, les arbitrages.
 *
 * ── Ce que le texte ne dit pas ──────────────────────────────────────────────
 * Une sonde qui ouvre un incident écrit une cause et un détail : « code 503,
 * 200 attendu », « connexion refusée ». C'est exact et c'est insuffisant. À
 * trois heures du matin, « code 503 » ne dit pas si la page était blanche, si
 * elle affichait une erreur de base de données, ou si le site avait été
 * remplacé. Pire : un site qui rend **200** avec un tunnel de paiement cassé,
 * une page de maintenance ou une défiguration est en panne pour ses visiteurs
 * et au vert pour la sonde. Aucune métrique n'attrape ce cas ; une image, si.
 *
 * ── Ce que ce n'est pas ─────────────────────────────────────────────────────
 * **Pas un type de sonde.** Le catalogue décrit ce qu'on observe (HTTP, TLS,
 * DNS…) ; la capture est une capacité **attachée aux incidents**, orthogonale
 * au type. Toute sonde dont la cible s'ouvre dans un navigateur — c'est
 * exactement ce que dit `linkFor()` du catalogue — peut en produire une. Un
 * type ajouté demain en hérite sans rien écrire ici.
 *
 * ── Ce module est pur ───────────────────────────────────────────────────────
 * Il est importé par des composants client. Aucun module natif, aucun réseau :
 * le navigateur se pilote depuis `@pupitre/core/capture`, qui n'est chargé que
 * par le worker.
 */

// ─── quand capturer ───────────────────────────────────────────────────────────

/**
 * Trois moments, et **seulement** trois. Capturer à chaque interrogation est
 * exclu : une sonde à la minute produirait 1 440 images par jour et par site,
 * pour montrer 1 439 fois la même page.
 *
 *   reference          « voici à quoi le site ressemble quand tout va bien ».
 *                      Prise pendant que la sonde est saine, au plus une fois
 *                      par `MONITOR_CAPTURE_REFERENCE_EVERY_HOURS`. C'est la
 *                      moitié « avant » de la comparaison, et sans elle l'image
 *                      d'incident ne se compare à rien : on ne saurait pas si
 *                      cette bannière rouge est nouvelle.
 *   incident_open      la page au moment où l'incident est confirmé. La raison
 *                      d'être de la fonctionnalité.
 *   incident_resolved  la page au rétablissement. Elle coûte une image par
 *                      incident et répond à la question qui suit toujours la
 *                      première — « c'est vraiment reparti, ou c'est la page de
 *                      maintenance qui répond 200 ? ». Une alerte de
 *                      rétablissement sans preuve oblige à aller vérifier à la
 *                      main, ce qu'on voulait justement éviter.
 */
export const CAPTURE_KINDS = ['reference', 'incident_open', 'incident_resolved'] as const;
export const captureKindSchema = z.enum(CAPTURE_KINDS);
export type CaptureKind = z.infer<typeof captureKindSchema>;

// Les libellés de chaque moment, et ceux des échecs, vivaient ici et n'avaient
// plus de lecteur : l'écran des captures écrit les siens, aux clés `capture.*`
// de son propre dictionnaire, donc dans la langue de l'instance.

/**
 * Cadence de la référence : **6 heures**.
 *
 * Le coût ne vient pas de la cadence mais de la rétention, et il n'y a jamais
 * qu'**une** référence vivante par sonde — une contrainte unique partielle en
 * base le garantit, ce n'est pas un `if`. Six heures est donc simplement « une
 * image assez fraîche pour que la comparaison soit honnête », sans harceler des
 * sites qui vont bien.
 */
export const MONITOR_CAPTURE_REFERENCE_EVERY_HOURS = 6;

/** Références rafraîchies par passage. Borne le travail d'un seul balayage. */
export const MONITOR_CAPTURE_REFERENCE_BATCH = 5;

/** Le balayage des références ne repart pas plus souvent que ça. */
export const MONITOR_CAPTURE_REFERENCE_SWEEP_EVERY_SECONDS = 300;

// ─── format et poids ──────────────────────────────────────────────────────────

/**
 * 1280 × 800 : un écran de bureau ordinaire. Ni mobile — on supervise des sites
 * dont on connaît la version de bureau — ni 4K, qui quadruplerait le poids pour
 * montrer la même chose.
 */
export const MONITOR_CAPTURE_WIDTH = 1280;
export const MONITOR_CAPTURE_VIEWPORT_HEIGHT = 800;

/**
 * Hauteur maximale rendue : **2 400 px**, soit trois écrans.
 *
 * La pleine hauteur est un piège : une page de blog fait 20 000 px, pèse
 * plusieurs mégaoctets en PNG, et les 19 000 px du bas ne disent rien qu'on
 * ignorait au premier. Ce qui diagnostique une panne est en haut. La capture
 * note quand elle a tronqué (`truncated`) : mieux vaut le dire que le cacher.
 */
export const MONITOR_CAPTURE_MAX_HEIGHT = 2_400;

/**
 * **JPEG, pas PNG.** Une page en pleine hauteur en PNG pèse 3 à 8 Mo ; la même
 * en JPEG de qualité 70 pèse 100 à 400 Ko, pour une perte invisible sur ce
 * qu'on vient y chercher (la page était-elle blanche, cassée, remplacée ?). Le
 * texte reste parfaitement lisible à cette qualité et à cette échelle.
 *
 * PNG aurait un avantage — la netteté parfaite du texte — qui ne vaut pas un
 * facteur vingt sur une donnée qu'on stocke pour toujours à côté d'incidents
 * qui ne sont jamais purgés.
 */
export const MONITOR_CAPTURE_FORMAT = 'jpeg' as const;
export const MONITOR_CAPTURE_QUALITY = 70;

/** Seconde tentative, plus économe, quand la première dépasse la borne dure. */
export const MONITOR_CAPTURE_FALLBACK_QUALITY = 40;
export const MONITOR_CAPTURE_FALLBACK_HEIGHT = 1_000;

/**
 * **Borne dure : 1,5 Mo.** Au-delà, l'image est jetée avec son motif plutôt que
 * stockée. Une borne molle (« on essaie de rester petit ») n'est pas une borne :
 * il suffit d'une page pathologique pour qu'une colonne `bytea` avale la
 * sauvegarde. Le chemin normal produit 100 à 400 Ko ; 1,5 Mo est l'accident.
 */
export const MONITOR_CAPTURE_MAX_BYTES = 1_500_000;

// ─── temps ────────────────────────────────────────────────────────────────────

/** Budget total d'une capture, connexion au navigateur comprise. */
export const MONITOR_CAPTURE_BUDGET_MS = 25_000;
/** Attente de l'événement `load` avant de tirer quand même. */
export const MONITOR_CAPTURE_LOAD_TIMEOUT_MS = 12_000;
/** Répit après `load` : le temps que les polices et l'hydratation se posent. */
export const MONITOR_CAPTURE_SETTLE_MS = 700;

// ─── rétention ────────────────────────────────────────────────────────────────

/**
 * **90 jours pour les octets ; la ligne, elle, ne part jamais.**
 *
 * Les incidents ne sont jamais purgés — ce sont eux qui racontent l'histoire —
 * mais leurs images, si : une sonde qui bat de l'aile produit trois images par
 * incident, et un incident par jour pendant un an, c'est un quart de gigaoctet
 * pour un seul site. Au-delà de trois mois, une capture n'aide plus à diagnostiquer,
 * elle documente.
 *
 * Ce qu'on purge est donc l'octet, pas le fait : la ligne reste, avec sa date,
 * sa taille et son verdict, et l'écran dit « image purgée le … ». Une
 * chronologie amputée mentirait ; une chronologie qui dit ce qu'elle a perdu,
 * non.
 */
export const MONITOR_CAPTURE_RETENTION_DAYS = 90;

// ─── le résultat d'une capture ────────────────────────────────────────────────

/**
 * Une capture ratée **n'est pas une erreur**.
 *
 * C'est la règle la plus importante du module. Le navigateur peut être éteint,
 * absent, saturé, ou la page peut ne jamais finir de charger : dans tous les
 * cas la sonde a déjà rendu son verdict, l'incident est déjà ouvert et l'alerte
 * est déjà partie. Une capture est un **supplément**, jamais une condition.
 * D'où un résultat en deux branches plutôt qu'une exception, et un motif
 * lisible dans la branche perdante.
 */
export type CaptureFailureReason =
  | 'browser-unavailable'
  | 'navigation-failed'
  | 'timeout'
  | 'too-large'
  | 'blocked'
  | 'not-capturable';

export type CaptureImage = {
  data: Uint8Array;
  format: typeof MONITOR_CAPTURE_FORMAT;
  width: number;
  height: number;
  /** La page était plus haute que `MONITOR_CAPTURE_MAX_HEIGHT`. */
  truncated: boolean;
  /** URL réellement rendue, après redirections. */
  finalUrl: string;
  /** Code de la réponse principale, quand le navigateur l'a vu passer. */
  httpStatus: number | null;
  pageTitle: string | null;
  /** Temps total, de la navigation à l'image. */
  elapsedMs: number;
};

export type CaptureOutcome =
  | { ok: true; image: CaptureImage }
  | { ok: false; reason: CaptureFailureReason; detail: string };

/** Une capture est-elle due pour cette sonde ? Pure, donc testable. */
export function referenceIsDue(lastReferenceAt: Date | null, now: Date = new Date()): boolean {
  if (lastReferenceAt === null) return true;
  const ageMs = now.getTime() - lastReferenceAt.getTime();
  return ageMs >= MONITOR_CAPTURE_REFERENCE_EVERY_HOURS * 3_600_000;
}

/**
 * Décide de la hauteur rendue à partir de la hauteur réelle de la page.
 *
 * Bornée en bas aussi : une page qui se déclare haute de 0 px (rendu raté,
 * corps vide) doit quand même produire une image — « la page était blanche »
 * est précisément l'un des diagnostics qu'on vient chercher.
 */
export function captureHeightFor(
  contentHeight: number,
  maxHeight: number = MONITOR_CAPTURE_MAX_HEIGHT,
): { height: number; truncated: boolean } {
  const wanted = Math.ceil(Number.isFinite(contentHeight) ? contentHeight : 0);
  if (wanted <= 0) return { height: MONITOR_CAPTURE_VIEWPORT_HEIGHT, truncated: false };
  if (wanted > maxHeight) return { height: maxHeight, truncated: true };
  return { height: Math.max(wanted, 200), truncated: false };
}

/**
 * Ce qu'on écrit à côté d'une image, et ce qu'on n'écrit pas.
 *
 * ⚠ **Une capture peut contenir n'importe quoi de ce que la page affiche.** Le
 * navigateur est vierge — contexte neuf à chaque capture, aucun cookie, aucune
 * session — donc il voit ce que verrait un visiteur anonyme : une page derrière
 * authentification rend son écran de connexion, pas le contenu privé. Reste le
 * cas de l'URL qui **porte** le secret (`?token=…`) : là, le navigateur rend le
 * contenu privé, et l'image le montre.
 *
 * Ce qui est fait de ce risque, explicitement :
 *   — l'URL supervisée est déjà lisible par quiconque a `monitor:read` (elle est
 *     dans `config`) : la capture n'ouvre pas un accès, elle rend visible ce que
 *     cet accès permettait déjà ;
 *   — l'image n'est servie qu'à `monitor:read`, jamais publiée, jamais jointe à
 *     une alerte, jamais envoyée à un webhook ni à un canal de notification ;
 *   — la fonctionnalité est **facultative et éteinte par défaut** : sans
 *     `MONITOR_CAPTURE_CDP_URL`, aucune image n'est prise ;
 *   — la fragment d'URL (`#…`) n'est pas transmis au navigateur — il ne sert à
 *     rien au rendu serveur et se retrouverait recopié en clair dans la table.
 */
export function captureUrlFor(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  return url.toString();
}
