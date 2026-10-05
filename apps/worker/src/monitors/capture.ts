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
 * Incident screenshots, worker side.
 *
 * ── The rule that takes precedence over all others ──────────────────────────
 * **A capture never fails a probe and never delays an alert.** It lives in its
 * own job, queued after the incident is written and the alert has gone out.
 * Every function of this file returns a report; none throws. A missing capture
 * is not an incident.
 *
 * ── What can be captured ────────────────────────────────────────────────────
 * Not "the HTTP probes" — capture is **orthogonal to the probe type**. What
 * matters is: does this probe designate a page a browser can open? The catalog
 * already knows, it is exactly `linkFor()`. A TLS probe returns `https://host/`
 * and will therefore be captured; a type with nothing to show returns `null` and
 * will be skipped, without a line changing here the day it arrives.
 */

/** Is capture configured on this instance? */
export function captureEnabled(): boolean {
  return env.MONITOR_CAPTURE_CDP_URL.trim() !== '';
}

const EMPTY: MonitorCaptureJobResult = { attempted: 0, stored: 0, bytes: 0, skipped: [] };

/**
 * The URL to render for a probe, or the reason there is none.
 *
 * A second SSRF guard, on top of the egress proxy, and deliberately redundant:
 * we refuse to *send* the browser to an internal address, even if the proxy
 * would have refused it anyway. The proxy protects from what the page attempts;
 * this one protects from what **we** ask.
 */
async function pageUrlFor(monitor: Monitor): Promise<{ url: string } | { skip: string }> {
  if (!isMonitorType(monitor.type)) return { skip: `unknown type "${monitor.type}"` };

  const link = monitorTargetLink(monitor.type, monitor.config);
  if (link === null) return { skip: 'this probe has no page to render' };

  const url = captureUrlFor(link);
  if (url === null) return { skip: `target "${link}" cannot be opened in a browser` };

  try {
    await resolveGuarded(new URL(url).hostname, allowedCidrs());
  } catch (error) {
    return { skip: error instanceof Error ? error.message : String(error) };
  }
  return { url };
}

/** Logs a capture failure without ever turning it into an error. */
function reportFailure(monitorId: string, kind: CaptureKind, outcome: CaptureOutcome): string {
  if (outcome.ok) return '';
  const message = `${outcome.reason} — ${outcome.detail}`;
  // `warn` for a browser that is off would be permanent noise on an instance that
  // simply did not enable the feature; `debug` for a page that did not load would
  // hide a real symptom. We tell them apart.
  const level = outcome.reason === 'browser-unavailable' ? 'debug' : 'warn';
  logger[level]({ monitorId, kind, reason: outcome.reason }, `capture not taken: ${message}`);
  return message;
}

/**
 * A capture, recorded if it succeeded.
 *
 * Returns the number of bytes written — zero if nothing was taken. The caller
 * does not tell "failed" from "off": in both cases there is nothing to show, and
 * nothing to fix in its own work.
 */
async function captureOne(
  monitor: Monitor,
  kind: CaptureKind,
  incidentId: string | null,
): Promise<{ bytes: number; skipped: string | null }> {
  const target = await pageUrlFor(monitor);
  if ('skip' in target) {
    logger.debug({ monitorId: monitor.id, kind }, `capture skipped: ${target.skip}`);
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
    'capture recorded',
  );
  return { bytes: saved.bytes, skipped: null };
}

/**
 * Refreshes the references that have aged.
 *
 * A reference is the comparison's "before". Without it, the incident image
 * compares to nothing: we do not know whether that red banner is new. It is
 * only taken while the probe is **healthy** — otherwise we would photograph the
 * outage and call it "normal state".
 *
 * Bounded to a few probes per pass: catching up for an instance that just
 * started must not be done all at once.
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
      // The browser is off: the next four probes would fail the same way, each paying
      // for a connection that times out. We stop.
      if (done.skipped.startsWith('browser-unavailable')) break;
    }
  }
  return result;
}

/**
 * An incident's capture: the outage image, and pinning the "before".
 *
 * Pinning comes **before** the capture, and the order matters: it is a one-row
 * `UPDATE`, it costs a millisecond and cannot fail for network reasons. Doing it
 * after would risk losing the "before" if the outage capture drags on and the
 * worker is stopped meanwhile.
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
      logger.debug({ monitorId, incidentId, captureId: pinned.id }, 'reference pinned');
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

/** The body of the `monitor:capture` job. Only throws on a program bug. */
export async function runMonitorCapture(
  data: MonitorCaptureJobData,
): Promise<MonitorCaptureJobResult> {
  if (!captureEnabled()) {
    // Neither error nor warning: the feature is simply off.
    return { ...EMPTY, skipped: ['capture disabled — MONITOR_CAPTURE_CDP_URL empty'] };
  }
  if (data.scope === 'references') return refreshReferences();
  return captureIncident(data.monitorId, data.incidentId, data.kind);
}
