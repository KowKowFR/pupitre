import {
  NOTIFICATION_DIGEST_ITEM_LIMIT,
  NOTIFICATION_DIGEST_MAX_ESCALATION,
  NOTIFICATION_DIGEST_WINDOW_MS_MAX,
  NOTIFICATION_DIGEST_WINDOW_MS_MIN,
  notificationDigestWindowMs,
} from '@pupitre/core';
import {
  getNotificationDigestPolicy,
  listNotificationDigestStates,
  logAudit,
  setNotificationDigestPolicy,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Le garde-fou de volume : son réglage, et son état à cet instant.
 *
 * ── Pourquoi exposer l'état et pas seulement le réglage ─────────────────────
 * Un opérateur qui ne reçoit rien doit pouvoir distinguer « rien ne s'est
 * passé » de « quarante alertes sont retenues, le résumé part dans deux
 * minutes ». Sans cette lecture, un regroupement actif est indiscernable d'une
 * couche de notification en panne — et la première réaction devant une couche
 * de notification suspectée en panne est de la reconfigurer, c'est-à-dire de
 * faire du bruit pour rien.
 *
 * ── Pourquoi le réglage est borné et non libre ──────────────────────────────
 * `NOTIFICATION_DIGEST_WINDOW_MS_MIN` interdit de descendre la fenêtre à zéro.
 * Un garde-fou de volume désactivable est un garde-fou désactivé au premier
 * agacement, et l'on retrouverait cinquante messages pour cinquante pannes. On
 * peut raccourcir la fenêtre — jusqu'à quinze secondes, ce qui revient à
 * n'attendre que le temps d'une rafale —, jamais la supprimer.
 *
 * `settings:read` / `settings:manage`, comme les canaux eux-mêmes : c'est le
 * même réglage d'instance, vu sous un autre angle.
 */

const patchSchema = z.object({
  windowMs: z
    .number()
    .int()
    .min(NOTIFICATION_DIGEST_WINDOW_MS_MIN)
    .max(NOTIFICATION_DIGEST_WINDOW_MS_MAX),
});

/** Les bornes, envoyées à l'écran : aucune valeur figée dans le composant. */
function vocabulary(windowMs: number) {
  return {
    minWindowMs: NOTIFICATION_DIGEST_WINDOW_MS_MIN,
    maxWindowMs: NOTIFICATION_DIGEST_WINDOW_MS_MAX,
    maxEscalation: NOTIFICATION_DIGEST_MAX_ESCALATION,
    /** Plafond réel de la fenêtre après élargissements, pour la base courante. */
    widestWindowMs: notificationDigestWindowMs(windowMs, NOTIFICATION_DIGEST_MAX_ESCALATION),
    itemLimit: NOTIFICATION_DIGEST_ITEM_LIMIT,
  };
}

export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'settings:read');

  const [policy, states] = await Promise.all([
    getNotificationDigestPolicy(),
    listNotificationDigestStates(),
  ]);

  return NextResponse.json({
    policy,
    // Seuls les groupes réellement en cours intéressent l'écran : une ligne
    // « silencieux » par événement du catalogue n'apprendrait rien.
    states: states.filter((state) => state.windowEndsAt !== null),
    vocabulary: vocabulary(policy.windowMs),
  });
});

export const PATCH = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'settings:manage');
  const body = await readJsonBody(request, patchSchema);

  const before = await getNotificationDigestPolicy();
  const after = await setNotificationDigestPolicy(body.windowMs, auth.userId);

  await logAudit({
    actorId: auth.userId,
    action: 'notification.digest.policy.updated',
    resourceType: 'notification_policy',
    resourceId: 'digest',
    before: { windowMs: before.windowMs },
    after: { windowMs: after.windowMs },
    ip: auth.ip,
  });

  return NextResponse.json({ policy: after, vocabulary: vocabulary(after.windowMs) });
});
