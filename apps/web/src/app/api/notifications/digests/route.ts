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
 * The volume guardrail: its setting, and its state at this instant.
 *
 * ── Why expose the state and not only the setting ───────────────────────────
 * An operator who receives nothing must be able to tell "nothing happened" from
 * "forty alerts are held, the digest goes out in two minutes". Without this read,
 * an active grouping is indistinguishable from a broken notification layer — and
 * the first reaction to a notification layer suspected broken is to reconfigure
 * it, that is to make noise for nothing.
 *
 * ── Why the setting is bounded and not free ─────────────────────────────────
 * `NOTIFICATION_DIGEST_WINDOW_MS_MIN` forbids bringing the window down to zero. A
 * volume guardrail that can be turned off is a guardrail turned off at the first
 * annoyance, and one would get fifty messages for fifty outages again. The window
 * can be shortened — down to fifteen seconds, which amounts to only waiting for a
 * burst —, never removed.
 *
 * `settings:read` / `settings:manage`, like the channels themselves: it is the
 * same instance setting, seen from another angle.
 */

const patchSchema = z.object({
  windowMs: z
    .number()
    .int()
    .min(NOTIFICATION_DIGEST_WINDOW_MS_MIN)
    .max(NOTIFICATION_DIGEST_WINDOW_MS_MAX),
});

/** The bounds, sent to the screen: no value frozen in the component. */
function vocabulary(windowMs: number) {
  return {
    minWindowMs: NOTIFICATION_DIGEST_WINDOW_MS_MIN,
    maxWindowMs: NOTIFICATION_DIGEST_WINDOW_MS_MAX,
    maxEscalation: NOTIFICATION_DIGEST_MAX_ESCALATION,
    /** The window's real cap after widenings, for the current database. */
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
    // Only the groups really in progress interest the screen: a "silent" row per
    // catalog event would teach nothing.
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
