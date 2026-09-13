import {
  DATE_STYLES,
  SUPPORTED_LOCALES,
  appSettingsPatchSchema,
  supportedTimeZones,
} from '@pupitre/core';
import { getAppSettings, logAudit, updateAppSettings, type AppSettingsRecord } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

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
});

/** Vocabulaire nécessaire à l'écran de réglage — pas de liste figée côté client. */
function vocabulary() {
  return {
    timezones: supportedTimeZones(),
    locales: [...SUPPORTED_LOCALES],
    dateStyles: [...DATE_STYLES],
  };
}

function present(record: AppSettingsRecord) {
  return {
    settings: record.settings,
    aiApiKeyConfigured: record.aiApiKeyConfigured,
    aiApiKeyLast4: record.aiApiKeyLast4,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}

export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'settings:read');
  const record = await getAppSettings();
  return NextResponse.json({ ...present(record), vocabulary: vocabulary() });
});

export const PATCH = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'settings:manage');
  const patch = await readJsonBody(request, patchSchema);

  const { before, after, keyChange } = await updateAppSettings(patch, auth.userId);

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
    before: { ...before.settings, aiApiKey: keyMarker(before.aiApiKeyConfigured) },
    after: {
      ...after.settings,
      aiApiKey: keyMarker(after.aiApiKeyConfigured),
      aiApiKeyChange: keyChange,
    },
    ip: auth.ip,
  });

  return NextResponse.json({ ...present(after), vocabulary: vocabulary() });
});
