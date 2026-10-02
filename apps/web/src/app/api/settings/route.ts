import {
  DATE_STYLES,
  SUPPORTED_LOCALES,
  appSettingsPatchSchema,
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
import { getEnv } from '@/lib/env';
import { HttpError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { getT } from '@/i18n/server';
import { refreshSso, ssoState } from '@/lib/sso';
import { describeSsoProblem } from '@/lib/sso-problem';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Paramètres d'instance.
 *
 * La clé d'API du fournisseur d'IA n'est **jamais** renvoyée, pas même
 * partiellement masquée : seulement le fait qu'elle soit posée et ses quatre
 * derniers caractères, qui suffisent à reconnaître laquelle est en place sans
 * permettre de s'en servir. Ce que `@pupitre/db` expose en lecture ne contient
 * physiquement pas la clé — impossible de la laisser fuir par oubli.
 */

/**
 * `aiApiKey` distingue trois intentions, et le schéma doit les préserver :
 *   champ absent → clé inchangée
 *   `null`       → clé effacée
 *   chaîne       → clé remplacée
 * `.nullable().optional()` est donc exigé : `.nullish()` ferait la même chose
 * ici, mais l'écrire en deux temps rappelle que `undefined` et `null` ne sont
 * pas interchangeables sur ce champ.
 */
const patchSchema = appSettingsPatchSchema.extend({
  aiApiKey: z.string().trim().min(8).max(400).nullable().optional(),
  /** Même convention que `aiApiKey` : absent, inchangé ; `null`, effacé. */
  ssoClientSecret: z.string().trim().min(1).max(400).nullable().optional(),
});

/** Vocabulaire nécessaire à l'écran de réglage — pas de liste figée côté client. */
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
    /** Ce que la connexion unique est **réellement**, une fois la découverte lue. */
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

  // Un rôle qui n'existe pas donnerait, à la connexion, le rôle par défaut sans
  // rien dire : on le refuse ici, où l'on peut encore le dire.
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

  const { before, after, keyChange, ssoSecretChange } = await updateAppSettings(patch, auth.userId);
  // La connexion unique se reconstruit sur ce qui vient d'être écrit — et dit
  // tout de suite, dans la réponse, si le fournisseur répond.
  if (patch.sso || Object.hasOwn(patch, 'ssoClientSecret')) await refreshSso();

  /**
   * L'audit porte les réglages en clair — ils n'ont rien de secret — mais la
   * clé y est réduite à un marqueur d'état. Une entrée d'audit est lue par
   * beaucoup de monde et conservée longtemps : c'est le dernier endroit où
   * l'on voudrait retrouver un secret.
   */
  // i18n-ignore — valeur écrite dans le journal d'activité. Une entrée d'audit
  // est une trace figée : la traduire à l'écriture fixerait sa langue pour
  // toujours, et la relire dans une autre demanderait qu'elle soit une donnée,
  // pas une phrase. Elle reste donc dans la langue du projet.
  const keyMarker = (configured: boolean): string => (configured ? '(défini)' : '(effacé)');

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
