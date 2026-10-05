import {
  buildMonitorAlert,
  languageOf,
  monitorTypeSchema,
  type MonitorStatus,
} from '@pupitre/core';
import { postWebhook } from '@pupitre/core/probe';
import {
  getAppSettingsValue,
  logAudit,
  markIncidentAlerted,
  monitorTarget,
  monitorWebhookUrl,
  type Monitor,
  type MonitorIncident,
} from '@pupitre/db';
import { instanceLanguage } from '../language.js';
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
 * ── Deux sorties, et c'est voulu ────────────────────────────────────────────
 * La couture annoncée a été tenue : les canaux de notification généraux (SMTP,
 * Telegram, Discord, webhook) sont désormais servis. Mais **pas** en remplaçant
 * le corps de cette fonction — en la laissant faire ce qu'elle faisait déjà :
 * écrire l'audit. `logAudit()` porte l'observateur qui reconnaît
 * `monitor.down` / `monitor.recovered` au catalogue d'événements et enfile la
 * distribution. Zéro appel à la fabrique de canaux depuis ici, zéro import de
 * `@pupitre/core/notifications` dans la supervision : le raccord tient dans
 * deux entrées de table, côté `packages/core/src/notifications/events.ts`.
 *
 *   sortie 1 — les canaux d'instance, via l'audit. Regroupement des rafales,
 *              résumés nommés, rejeu par canal : hérité, pas réécrit.
 *   sortie 2 — le webhook **de cette sonde**, ci-dessous, inchangé.
 *
 * ── Pourquoi le webhook par sonde n'a pas disparu ───────────────────────────
 * Il aurait été facile de le retirer « puisque les canaux font mieux ». Ils ne
 * font pas la même chose. Un canal est abonné à un *événement*, donc à **toutes**
 * les sondes de l'instance ; ce webhook est attaché à **une** sonde. Un
 * hébergeur qui surveille trente sites pour vingt clients veut le salon Slack
 * du client dans le webhook de sa sonde, et surtout pas les vingt-neuf autres.
 * Le supprimer forcerait ce cas à recevoir tout ou rien : une régression sans
 * équivalent de remplacement.
 *
 * Les deux peuvent donc se déclencher pour la même panne. Ce n'est pas un
 * doublon accidentel : ce sont deux abonnements distincts, posés par deux
 * gestes distincts, et l'écran des sondes le dit en toutes lettres au moment de
 * saisir l'URL. La charge utile diffère d'ailleurs — ici un `MonitorAlert`
 * brut, taillé pour Slack et Discord (`text` / `content`, métriques, identifiant
 * d'incident) ; là un message neutre rendu par chaque canal dans sa forme.
 *
 * Règles que cette couture tient :
 *
 *   1. On alerte **à la transition**, jamais à chaque échec. Cinquante messages
 *      pour une panne, personne ne les lit. C'est la machine à états qui décide
 *      de la transition ; cette fonction n'est appelée que quand elle a lieu.
 *      Les deux sorties héritent de cette hystérésis, puisqu'elles partent
 *      toutes deux d'ici.
 *   2. On alerte **aussi au rétablissement**. Une alerte sans son pendant
 *      oblige à aller vérifier à la main, ce qui est exactement ce qu'on
 *      voulait éviter.
 *   3. L'émission **une seule fois** est garantie en amont par l'index unique
 *      partiel sur les incidents ouverts : pas d'incident ouvert deux fois,
 *      donc pas de message deux fois.
 *   4. Un webhook injoignable **ne fait pas échouer le balayage** : l'échec est
 *      consigné sur l'incident (`alert_error`) et audité. Perdre la mesure
 *      parce que Slack était en panne serait le comble. Il ne fait pas non plus
 *      échouer la sortie 1 : l'audit est écrit **avant**, donc les canaux sont
 *      déjà servis quand le webhook expire.
 *
 * La valeur de retour ne concerne que la **sortie 2** : elle alimente le
 * compteur `alerts` du balayage, qui compte des remises de webhook de sonde. Les
 * remises par canal sont asynchrones — elles vivent dans la file des
 * notifications et se comptent là-bas.
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

  /**
   * La langue de l'alerte est celle de **l'instance**, comme pour les canaux de
   * notification (`handlers/notification.ts`) : personne n'est devant un écran
   * quand un site tombe, et le salon Slack qui reçoit la phrase est celui de
   * l'exploitant. Une transition est rare — quelques-unes par jour au pire —,
   * donc cette lecture ne pèse sur aucun chemin chaud.
   */
  const settings = await getAppSettingsValue();
  const language = languageOf(settings.locale);

  const alert = buildMonitorAlert(
    {
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
    },
    language,
  );

  /**
   * Le changement d'état est tracé **quoi qu'il arrive** — même sans webhook
   * configuré. Le journal d'audit est la mémoire de l'exploitation ; il ne
   * dépend pas de la présence d'un récepteur.
   *
   * Et c'est désormais bien plus que de la mémoire : `logAudit()` est le point
   * où l'observateur des notifications reconnaît `monitor.down` /
   * `monitor.recovered` au catalogue (`@pupitre/core` → `notifiableEventFor`) et
   * enfile la distribution vers les canaux abonnés. Autrement dit, **cette
   * charge utile est le message**. Ce qui n'y figure pas ne pourra pas être dit
   * à l'opérateur — d'où `startedAt` et `durationSeconds`, sans lesquels un
   * résumé ne saurait dire « rétabli après 4 min » et se réduirait à un
   * compteur.
   *
   * Rien de secret n'y entre : le nom, la cible publique, le verdict et les
   * mesures. L'URL du webhook de la sonde, elle, n'est jamais écrite ici — pas
   * plus que dans les logs.
   */
  const durationSeconds = incident.resolvedAt
    ? Math.max(
        0,
        Math.round((incident.resolvedAt.getTime() - incident.startedAt.getTime()) / 1000),
      )
    : null;

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
      startedAt: incident.startedAt.toISOString(),
      resolvedAt: incident.resolvedAt?.toISOString() ?? null,
      durationSeconds,
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

  const delivery = await postWebhook({
    url,
    payload: alert,
    allowlist: allowedCidrs(),
    language: await instanceLanguage(),
  });

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
