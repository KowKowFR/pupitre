import {
  DATE_STYLES,
  SUPPORTED_LOCALES,
  appSettingsPatchSchema,
  requiresTwoFactor,
  ssoCallbackUrl,
  supportedTimeZones,
} from '@pupitre/core';
import {
  getAppSettings,
  getRoleByKey,
  logAudit,
  updateAppSettings,
  type AppSettingsRecord,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { settings as messages } from '@/i18n/messages/settings';
import { hasPassword } from '@/lib/auth';
import { getEnv } from '@/lib/env';
import { HttpError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { getT } from '@/i18n/server';
import { clampOpenSessions, refreshSessionPolicy } from '@/lib/session-policy';
import { refreshSso, ssoState } from '@/lib/sso';
import { describeSsoProblem } from '@/lib/sso-problem';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Instance settings.
 *
 * The AI provider's API key is **never** returned, not even partially masked:
 * only the fact that it is set and its last four characters, which are enough to
 * recognize which one is in place without allowing to use it. What `@pupitre/db`
 * exposes for reading physically does not contain the key — impossible to let it
 * leak by omission.
 */

/**
 * `aiApiKey` tells three intentions apart, and the schema must preserve them:
 *   absent field → key unchanged
 *   `null`       → key cleared
 *   string       → key replaced
 * `.nullable().optional()` is therefore required: `.nullish()` would do the same
 * thing here, but writing it in two steps recalls that `undefined` and `null` are
 * not interchangeable on this field.
 */
const patchSchema = appSettingsPatchSchema.extend({
  aiApiKey: z.string().trim().min(8).max(400).nullable().optional(),
  /** The same convention as `aiApiKey`: absent, unchanged; `null`, cleared. */
  ssoClientSecret: z.string().trim().min(1).max(400).nullable().optional(),
});

/** The vocabulary the settings screen needs — no frozen list on the client side. */
function vocabulary() {
  return {
    timezones: supportedTimeZones(),
    locales: [...SUPPORTED_LOCALES],
    dateStyles: [...DATE_STYLES],
  };
}

async function present(record: AppSettingsRecord) {
  const sso = ssoState();
  const t = await getT(messages);
  return {
    settings: record.settings,
    aiApiKeyConfigured: record.aiApiKeyConfigured,
    aiApiKeyLast4: record.aiApiKeyLast4,
    ssoClientSecretConfigured: record.ssoClientSecretConfigured,
    /** What single sign-on **really** is, once the discovery is read. */
    ssoStatus: {
      active: sso.runtime !== null,
      error: sso.problem ? describeSsoProblem(sso.problem, t) : null,
      callbackUrl: ssoCallbackUrl(getEnv().BETTER_AUTH_URL),
    },
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}

export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'settings:read');
  const record = await getAppSettings();
  return NextResponse.json({ ...(await present(record)), vocabulary: vocabulary() });
});

export const PATCH = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'settings:manage');
  const patch = await readJsonBody(request, patchSchema);

  // A role that does not exist would give, at sign-in, the default role without
  // saying anything: we refuse it here, where it can still be said.
  if (patch.sso) {
    const keys = [
      ...(patch.sso.defaultRole ? [patch.sso.defaultRole] : []),
      ...(patch.sso.roleMappings ?? []).map((mapping) => mapping.role),
    ];
    for (const key of new Set(keys)) {
      if (!(await getRoleByKey(key))) {
        throw new HttpError(422, 'unknown_role', msg(messages, 'sso.error.unknownRole', { key }));
      }
    }
  }

  // Requiring the second factor without having it oneself: the save would right
  // away close the panel to whoever made it. We say so here instead.
  const policy = patch.accounts?.twoFactorPolicy;
  if (
    policy &&
    requiresTwoFactor(auth.permissions, policy) &&
    !auth.twoFactor.enabled &&
    (await hasPassword(auth.userId))
  ) {
    throw new HttpError(409, 'two_factor_self', msg(messages, 'accounts.error.self'));
  }

  const { before, after, keyChange, ssoSecretChange } = await updateAppSettings(patch, auth.userId);
  // Single sign-on is rebuilt on what was just written — and says right away, in
  // the response, whether the provider answers.
  if (patch.sso || Object.hasOwn(patch, 'ssoClientSecret')) await refreshSso();
  // The sessions' duration is read by Better Auth at its construction: the policy
  // read again, `getAuth()` rebuilds its instance.
  if (patch.accounts) {
    const policy = await refreshSessionPolicy();
    if (after.settings.accounts.sessionIdleHours < before.settings.accounts.sessionIdleHours) {
      await clampOpenSessions(policy.idleSeconds);
    }
  }

  /**
   * The audit carries the settings in clear — they have nothing secret — but the
   * key is reduced to a state marker there. An audit entry is read by many people
   * and kept for a long time: it is the last place one would want to find a secret.
   */
  // i18n-ignore — a value written to the activity log. An audit entry is a frozen
  // trace: translating it at write time would fix its language forever, and reading
  // it in another would require it to be data, not a sentence. It therefore stays
  // in the project's language.
  const keyMarker = (configured: boolean): string => (configured ? '(set)' : '(cleared)');

  await logAudit({
    actorId: auth.userId,
    action: 'settings.updated',
    resourceType: 'settings',
    resourceId: 'app',
    before: {
      ...before.settings,
      aiApiKey: keyMarker(before.aiApiKeyConfigured),
      ssoClientSecret: keyMarker(before.ssoClientSecretConfigured),
    },
    after: {
      ...after.settings,
      aiApiKey: keyMarker(after.aiApiKeyConfigured),
      aiApiKeyChange: keyChange,
      ssoClientSecret: keyMarker(after.ssoClientSecretConfigured),
      ssoClientSecretChange: ssoSecretChange,
    },
    ip: auth.ip,
  });

  return NextResponse.json({ ...(await present(after)), vocabulary: vocabulary() });
});
