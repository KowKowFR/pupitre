import {
  HOST_METRIC_CATALOG,
  logAudit,
  type BreachTransition,
  type TargetMetricSample,
} from '@pupitre/db';
import { logger } from '../logger.js';
import { instanceLanguage } from '../language.js';

/**
 * ⟵ **LA COUTURE** ⟶
 *
 * Le seul endroit du chantier où un franchissement de seuil devient un
 * message. Le balayage constate, la règle décide, cette fonction raconte.
 *
 * ── Pourquoi ça passe par `logAudit()` et rien d'autre ──────────────────────
 * Règle 6 du projet : point d'entrée unique. Et ce n'est pas qu'une question de
 * discipline — `logAudit()` porte l'observateur qui reconnaît une action au
 * catalogue d'événements et enfile la distribution vers les canaux abonnés
 * (SMTP, Telegram, Discord, webhook). Écrire l'audit **est** donc l'émission :
 * il n'y a aucun appel à la fabrique de canaux ici, aucun import de
 * `@pupitre/core/notifications`, exactement comme la supervision de sites
 * (`monitors/notify.ts`). Le raccord au catalogue tient dans deux entrées de
 * table, côté `packages/core/src/notifications/events.ts` — hors périmètre de ce
 * chantier, et volontairement laissé à faire.
 *
 * ── Ce que cette charge utile doit contenir ─────────────────────────────────
 * Ce qui n'y figure pas ne pourra pas être dit à l'opérateur. D'où :
 *   — `metric`, `value`, `limitPercent` : de quoi écrire « disque à 92 %,
 *     au-dessus de 90 % » sans aller relire la base ;
 *   — `peakValue` et `durationSeconds` au rétablissement : un résumé qui dit
 *     « rentré dans l'ordre après 3 h, 97 % au pire » vaut cent fois un
 *     compteur ;
 *   — `targetName` : un identifiant UUID dans un message Telegram n'aide
 *     personne.
 *
 * ── Les deux règles anti-déluge, et où elles vivent ─────────────────────────
 *   1. **Le franchissement est l'événement, pas l'état.** Cette fonction n'est
 *      appelée qu'aux bascules — `evaluateThresholds()` ne rend rien tant que
 *      rien ne bascule. Une machine à 92 % de disque pendant trois jours produit
 *      une entrée, pas 864.
 *   2. **Une seule fois, structurellement.** Garanti en amont par l'index unique
 *      partiel sur les dépassements ouverts : pas deux épisodes ouverts sur la
 *      même machine et la même métrique, donc pas deux messages — même si le
 *      balayage et un « Relever » manuel concluaient à la même seconde.
 *
 * On annonce **aussi le retour à la normale**. Une alerte sans son pendant
 * oblige à aller vérifier à la main, ce qui est exactement ce qu'on voulait
 * éviter.
 */
export async function notifyBreachTransition(
  target: { id: string; name: string },
  transition: BreachTransition,
  sample: TargetMetricSample,
): Promise<void> {
  const definition = HOST_METRIC_CATALOG[transition.metric];
  const breach = transition.breach;
  // L'alerte est composée ici, une fois : dans la langue de l'instance.
  const language = await instanceLanguage();

  const durationSeconds = breach.resolvedAt
    ? Math.max(0, Math.round((breach.resolvedAt.getTime() - breach.startedAt.getTime()) / 1000))
    : null;

  const action =
    transition.kind === 'opened' ? 'target.threshold.breached' : 'target.threshold.cleared';

  await logAudit({
    action,
    resourceType: 'target',
    resourceId: target.id,
    before: { limitPercent: breach.limitPercent },
    after: {
      targetName: target.name,
      metric: transition.metric,
      metricLabel: definition.label(language),
      // La phrase toute faite : « disque /opt/bootstrap à 92.4 % ». Le catalogue
      // la compose, parce qu'il est le seul à savoir ce que la valeur signifie.
      detail: definition.describe(transition.value, sample, language),
      value: transition.value,
      limitPercent: breach.limitPercent,
      peakValue: breach.peakValue,
      samples: breach.samples,
      breachId: breach.id,
      startedAt: breach.startedAt.toISOString(),
      resolvedAt: breach.resolvedAt?.toISOString() ?? null,
      durationSeconds,
      // `threshold_disabled` : l'épisode s'est refermé parce qu'on a coupé le
      // seuil, pas parce que la machine va mieux. Le dire évite un faux soulagement.
      reason: transition.reason,
      thresholdOrigin: transition.threshold.origin,
    },
  });

  logger.info(
    {
      targetId: target.id,
      metric: transition.metric,
      kind: transition.kind,
      value: transition.value,
      limitPercent: breach.limitPercent,
      reason: transition.reason,
    },
    transition.kind === 'opened' ? 'seuil franchi' : 'seuil de nouveau respecté',
  );
}
