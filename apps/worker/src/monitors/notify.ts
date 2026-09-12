import { buildMonitorAlert, monitorTypeSchema, type MonitorStatus } from '@pupitre/core';
import { postWebhook } from '@pupitre/core/probe';
import {
  logAudit,
  markIncidentAlerted,
  monitorTarget,
  monitorWebhookUrl,
  type Monitor,
  type MonitorIncident,
} from '@pupitre/db';
import { logger } from '../logger.js';
import { allowedCidrs } from './policy.js';

/**
 * ⟵ **LA COUTURE** ⟶
 *
 * Tout ce que la supervision de sites émet vers l'extérieur passe par cette
 * unique fonction. Le reste du code — le balayage, la machine à états — ne
 * connaît ni webhook, ni `fetch`, ni format de charge utile : il constate une
 * transition et appelle `notifyMonitorTransition()`.
 *
 * C'est délibéré et c'est le point de reprise. Une couche de notifications
 * générale est prévue (SMTP, Telegram, Discord, webhook, derrière une fabrique
 * comme `DeploymentDriver` ou `Scanner`). Le jour où elle existe, il y a **un
 * seul corps de fonction à remplacer ici** : remplacer l'appel à `postWebhook`
 * par un appel à la fabrique, garder la même signature, garder l'audit et le
 * marquage d'incident. Aucun appel dispersé à aller chercher ailleurs.
 *
 * Règles que cette couture tient, et qui devront survivre au remplacement :
 *
 *   1. On alerte **à la transition**, jamais à chaque échec. Cinquante messages
 *      pour une panne, personne ne les lit. C'est la machine à états qui décide
 *      de la transition ; cette fonction n'est appelée que quand elle a lieu.
 *   2. On alerte **aussi au rétablissement**. Une alerte sans son pendant
 *      oblige à aller vérifier à la main, ce qui est exactement ce qu'on
 *      voulait éviter.
 *   3. L'émission **une seule fois** est garantie en amont par l'index unique
 *      partiel sur les incidents ouverts : pas d'incident ouvert deux fois,
 *      donc pas de message deux fois.
 *   4. Un webhook injoignable **ne fait pas échouer le balayage** : l'échec est
 *      consigné sur l'incident (`alert_error`) et audité. Perdre la mesure
 *      parce que Slack était en panne serait le comble.
 */
export async function notifyMonitorTransition(
  monitor: Monitor,
  from: MonitorStatus,
  to: MonitorStatus,
  incident: MonitorIncident,
): Promise<boolean> {
  const event = to === 'healthy' ? 'monitor.up' : 'monitor.down';
  const kind = event === 'monitor.up' ? 'resolve' : 'open';

  const target = monitorTarget(monitor);

  const alert = buildMonitorAlert({
    event,
    monitor: {
      id: monitor.id,
      name: monitor.name,
      type: monitorTypeSchema.parse(monitor.type),
      target,
    },
    incident: {
      id: incident.id,
      startedAt: incident.startedAt,
      resolvedAt: incident.resolvedAt,
    },
    status: to,
    detail: monitor.lastDetail,
    metrics: monitor.lastMetrics ?? {},
    consecutiveFailures: incident.failureCount,
  });

  // Le changement d'état est tracé **quoi qu'il arrive** — même sans webhook
  // configuré. Le journal d'audit est la mémoire de l'exploitation ; il ne
  // dépend pas de la présence d'un récepteur.
  await logAudit({
    action: event === 'monitor.up' ? 'monitor.recovered' : 'monitor.down',
    resourceType: 'monitor',
    resourceId: monitor.id,
    before: { status: from },
    after: {
      status: to,
      name: monitor.name,
      type: monitor.type,
      target,
      incidentId: incident.id,
      detail: monitor.lastDetail,
      metrics: monitor.lastMetrics ?? {},
      consecutiveFailures: incident.failureCount,
    },
  });

  let url: string | null;
  try {
    url = monitorWebhookUrl(monitor);
  } catch (error) {
    // Une URL chiffrée sous une autre `MASTER_KEY` : on le dit, on ne plante pas.
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ monitorId: monitor.id, err: error }, 'webhook de sonde illisible');
    await markIncidentAlerted(incident.id, kind, { ok: false, error: message });
    return false;
  }

  if (!url) return false;

  const delivery = await postWebhook({ url, payload: alert, allowlist: allowedCidrs() });

  await markIncidentAlerted(
    incident.id,
    kind,
    delivery.ok ? { ok: true } : { ok: false, error: delivery.error },
  );

  if (!delivery.ok) {
    // Jamais l'URL dans les logs : c'est le secret.
    logger.warn(
      { monitorId: monitor.id, incidentId: incident.id, error: delivery.error },
      "alerte de supervision non remise",
    );
    return false;
  }

  logger.info({ monitorId: monitor.id, incidentId: incident.id, event }, 'alerte de supervision émise');
  return true;
}
