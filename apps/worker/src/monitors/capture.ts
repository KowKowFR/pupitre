import {
  MONITOR_CAPTURE_BUDGET_MS,
  MONITOR_CAPTURE_REFERENCE_BATCH,
  MONITOR_CAPTURE_REFERENCE_EVERY_HOURS,
  captureUrlFor,
  isMonitorType,
  monitorTargetLink,
  type CaptureKind,
  type CaptureOutcome,
  type MonitorCaptureJobData,
  type MonitorCaptureJobResult,
} from '@pupitre/core';
import { captureUrl } from '@pupitre/core/capture';
import { resolveGuarded } from '@pupitre/core/probe';
import {
  getMonitor,
  monitorsDueForReference,
  pinReferenceToIncident,
  saveCapture,
  type Monitor,
} from '@pupitre/db';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { allowedCidrs } from './policy.js';

/**
 * Les captures d'écran d'incident, côté worker.
 *
 * ── La règle qui prime sur toutes les autres ────────────────────────────────
 * **Une capture ne fait jamais échouer une sonde et ne retarde jamais une
 * alerte.** Elle vit dans sa propre tâche, enfilée après que l'incident est
 * écrit et que l'alerte est partie. Toutes les fonctions de ce fichier rendent
 * un compte-rendu ; aucune ne lève. Une capture absente n'est pas un incident.
 *
 * ── Ce qui est capturable ───────────────────────────────────────────────────
 * Pas « les sondes HTTP » — la capture est **orthogonale au type de sonde**.
 * Ce qui compte est : cette sonde désigne-t-elle une page qu'un navigateur
 * peut ouvrir ? Le catalogue le sait déjà, c'est exactement `linkFor()`. Une
 * sonde TLS rend `https://hôte/` et sera donc capturée ; un type qui n'a rien à
 * montrer rend `null` et sera sauté, sans qu'une ligne change ici le jour où il
 * arrive.
 */

/** La capture est-elle configurée sur cette instance ? */
export function captureEnabled(): boolean {
  return env.MONITOR_CAPTURE_CDP_URL.trim() !== '';
}

const EMPTY: MonitorCaptureJobResult = { attempted: 0, stored: 0, bytes: 0, skipped: [] };

/**
 * L'URL à rendre pour une sonde, ou le motif pour lequel il n'y en a pas.
 *
 * Deuxième garde SSRF, en plus du mandataire de sortie, et volontairement
 * redondante : on refuse d'*envoyer* le navigateur sur une adresse interne,
 * même si le mandataire l'aurait de toute façon refusée. Le mandataire protège
 * de ce que la page tente ; celle-ci protège de ce que **nous** demandons.
 */
async function pageUrlFor(monitor: Monitor): Promise<{ url: string } | { skip: string }> {
  if (!isMonitorType(monitor.type)) return { skip: `type « ${monitor.type} » inconnu` };

  const link = monitorTargetLink(monitor.type, monitor.config);
  if (link === null) return { skip: "cette sonde n'a pas de page à rendre" };

  const url = captureUrlFor(link);
  if (url === null) return { skip: `cible « ${link} » non ouvrable dans un navigateur` };

  try {
    await resolveGuarded(new URL(url).hostname, allowedCidrs());
  } catch (error) {
    return { skip: error instanceof Error ? error.message : String(error) };
  }
  return { url };
}

/** Journalise un échec de capture sans jamais le transformer en erreur. */
function reportFailure(monitorId: string, kind: CaptureKind, outcome: CaptureOutcome): string {
  if (outcome.ok) return '';
  const message = `${outcome.reason} — ${outcome.detail}`;
  // `warn` pour un navigateur éteint serait du bruit permanent sur une instance
  // qui n'a simplement pas activé la fonctionnalité ; `debug` pour une page qui
  // n'a pas chargé cacherait un vrai symptôme. On distingue.
  const level = outcome.reason === 'browser-unavailable' ? 'debug' : 'warn';
  logger[level]({ monitorId, kind, reason: outcome.reason }, `capture non réalisée : ${message}`);
  return message;
}

/**
 * Une capture, enregistrée si elle a abouti.
 *
 * Rend le nombre d'octets écrits — zéro si rien n'a été pris. L'appelant ne
 * distingue pas « raté » de « éteint » : dans les deux cas il n'y a rien à
 * montrer, et rien à corriger dans son propre travail.
 */
async function captureOne(
  monitor: Monitor,
  kind: CaptureKind,
  incidentId: string | null,
): Promise<{ bytes: number; skipped: string | null }> {
  const target = await pageUrlFor(monitor);
  if ('skip' in target) {
    logger.debug({ monitorId: monitor.id, kind }, `capture sautée : ${target.skip}`);
    return { bytes: 0, skipped: target.skip };
  }

  const outcome = await captureUrl({
    cdpUrl: env.MONITOR_CAPTURE_CDP_URL,
    url: target.url,
    budgetMs: MONITOR_CAPTURE_BUDGET_MS,
  });

  if (!outcome.ok) return { bytes: 0, skipped: reportFailure(monitor.id, kind, outcome) };

  const saved = await saveCapture({
    monitorId: monitor.id,
    incidentId,
    kind,
    url: target.url,
    image: outcome.image,
  });

  logger.info(
    {
      monitorId: monitor.id,
      captureId: saved.id,
      kind,
      bytes: saved.bytes,
      height: saved.height,
      truncated: saved.truncated,
      httpStatus: saved.httpStatus,
      elapsedMs: outcome.image.elapsedMs,
    },
    'capture enregistrée',
  );
  return { bytes: saved.bytes, skipped: null };
}

/**
 * Rafraîchit les références qui ont vieilli.
 *
 * Une référence est le « avant » de la comparaison. Sans elle, l'image
 * d'incident ne se compare à rien : on ne sait pas si cette bannière rouge est
 * nouvelle. Elle n'est prise que pendant que la sonde est **saine** — sans quoi
 * on photographierait la panne et on l'appellerait « état normal ».
 *
 * Borné à quelques sondes par passage : le rattrapage d'une instance qui vient
 * de démarrer ne doit pas se faire en une fois.
 */
async function refreshReferences(): Promise<MonitorCaptureJobResult> {
  const candidates = await monitorsDueForReference(
    MONITOR_CAPTURE_REFERENCE_EVERY_HOURS,
    MONITOR_CAPTURE_REFERENCE_BATCH,
  );
  const result: MonitorCaptureJobResult = { attempted: 0, stored: 0, bytes: 0, skipped: [] };

  for (const candidate of candidates) {
    const monitor = await getMonitor(candidate.monitorId);
    if (!monitor) continue;
    result.attempted += 1;
    const done = await captureOne(monitor, 'reference', null);
    if (done.skipped === null) {
      result.stored += 1;
      result.bytes += done.bytes;
    } else {
      result.skipped.push(done.skipped);
      // Le navigateur est éteint : les quatre sondes suivantes échoueraient de
      // la même façon, en payant chacune une connexion qui expire. On s'arrête.
      if (done.skipped.startsWith('browser-unavailable')) break;
    }
  }
  return result;
}

/**
 * La capture d'un incident : l'image de la panne, et l'épinglage du « avant ».
 *
 * L'épinglage vient **avant** la capture, et l'ordre compte : c'est un `UPDATE`
 * d'une ligne, il coûte une milliseconde et ne peut pas échouer pour cause de
 * réseau. Le faire après exposerait à perdre le « avant » si la capture de la
 * panne traîne et que le worker est arrêté entre-temps.
 */
async function captureIncident(
  monitorId: string,
  incidentId: string,
  kind: 'incident_open' | 'incident_resolved',
): Promise<MonitorCaptureJobResult> {
  const monitor = await getMonitor(monitorId);
  if (!monitor) return EMPTY;

  if (kind === 'incident_open') {
    const pinned = await pinReferenceToIncident(monitorId, incidentId);
    if (pinned) {
      logger.debug({ monitorId, incidentId, captureId: pinned.id }, 'référence épinglée');
    }
  }

  const done = await captureOne(monitor, kind, incidentId);
  return {
    attempted: 1,
    stored: done.skipped === null ? 1 : 0,
    bytes: done.bytes,
    skipped: done.skipped === null ? [] : [done.skipped],
  };
}

/** Le corps de la tâche `monitor:capture`. Ne lève que sur bogue de programme. */
export async function runMonitorCapture(
  data: MonitorCaptureJobData,
): Promise<MonitorCaptureJobResult> {
  if (!captureEnabled()) {
    // Ni erreur, ni avertissement : la fonctionnalité est simplement éteinte.
    return { ...EMPTY, skipped: ['capture désactivée — MONITOR_CAPTURE_CDP_URL vide'] };
  }
  if (data.scope === 'references') return refreshReferences();
  return captureIncident(data.monitorId, data.incidentId, data.kind);
}
