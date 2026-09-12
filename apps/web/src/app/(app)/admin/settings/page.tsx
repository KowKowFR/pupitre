import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { SCANNER_KEYS, FAIL_ON_LABELS, scannerLabel } from '@pupitre/core';
import { getAiApiKey, getAppSettings, listNotificationChannels } from '@pupitre/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime, formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { SETTINGS_SECTIONS } from './sections';
import { AiStatusBadge } from './ai-status';

export const dynamic = 'force-dynamic';

const ONBOARDING_LABEL = {
  pending: 'jamais lancé',
  in_progress: 'en cours',
  dismissed: 'abandonné',
  completed: 'terminé',
} as const;

/** Instant de référence de l'aperçu de date — le même que sur la section. */
const PREVIEW_INSTANT = new Date('2026-01-15T14:32:07Z');

/**
 * Sommaire des paramètres.
 *
 * `/admin/settings` reste une adresse utile plutôt qu'une redirection : c'est
 * la réponse à « dans quel état est cette instance ? », en un écran et sans
 * ouvrir cinq pages. Chaque panneau dit ce que la section gouverne, montre la
 * valeur en vigueur, et mène à l'écran qui la change.
 *
 * Rien ici n'est modifiable : le sommaire lit, les sections écrivent. C'est
 * aussi ce qui permet de le montrer tel quel à un lecteur sans
 * `settings:manage`.
 */
export default async function SettingsOverviewPage() {
  await requirePagePermission('/admin/settings', 'settings:read');
  const record = await getAppSettings();
  const { settings } = record;
  // La clé ne descend jamais au client : elle sert ici, côté serveur, à savoir
  // si la génération est réellement possible — pas seulement autorisée.
  const aiApiKey = await getAiApiKey();
  const channels = await listNotificationChannels();
  const activeChannels = channels.filter((channel) => channel.enabled);

  const activeScanners = SCANNER_KEYS.filter(
    (key) => !settings.security.disabledScanners.includes(key),
  );

  const readouts: Record<string, { term: string; value: ReactNode }[]> = {
    '/admin/settings/identite': [
      { term: 'Nom', value: settings.instanceName },
      {
        term: 'Sous-titre',
        value: settings.instanceTagline === '' ? '—' : settings.instanceTagline,
      },
    ],
    '/admin/settings/regionalisation': [
      { term: 'Fuseau', value: settings.timezone },
      { term: 'Locale', value: settings.locale },
      {
        term: 'Rendu',
        value: formatDateTime(PREVIEW_INSTANT, formatSettingsOf(settings)),
      },
    ],
    '/admin/settings/securite': [
      {
        term: 'Scanners actifs',
        value: settings.security.scanningEnabled
          ? activeScanners.length === 0
            ? 'aucun'
            : activeScanners.map(scannerLabel).join(', ')
          : 'aucun — analyse coupée',
      },
      { term: 'Seuil de blocage', value: FAIL_ON_LABELS[settings.security.failOn] },
    ],
    '/admin/settings/notifications': [
      {
        term: 'Canaux',
        value:
          channels.length === 0
            ? 'aucun — personne n’est prévenu'
            : `${activeChannels.length} actif${activeChannels.length > 1 ? 's' : ''} sur ${channels.length}`,
      },
      {
        term: 'Événements couverts',
        value: String(new Set(activeChannels.flatMap((channel) => channel.events)).size),
      },
      {
        term: 'En échec',
        value: String(channels.filter((channel) => channel.consecutiveFailures > 0).length),
      },
    ],
    '/admin/settings/ia': [
      { term: 'Fournisseur', value: settings.ai.provider },
      { term: 'Modèle', value: settings.ai.model },
      {
        term: "Clé d'API",
        value: record.aiApiKeyConfigured
          ? `enregistrée${record.aiApiKeyLast4 ? ` — …${record.aiApiKeyLast4}` : ''}`
          : 'aucune — repli sur la variable d’environnement',
      },
    ],
    '/admin/settings/demarrage': [
      { term: 'État', value: ONBOARDING_LABEL[settings.onboarding.status] },
      { term: 'Étape en cours', value: settings.onboarding.currentStep },
      { term: 'Relances', value: String(settings.onboarding.runs) },
    ],
  };

  const badges: Record<string, ReactNode> = {
    '/admin/settings/securite': (
      <Badge variant={settings.security.scanningEnabled ? 'ok' : 'destructive'}>
        {settings.security.scanningEnabled ? 'active' : 'désactivée'}
      </Badge>
    ),
    '/admin/settings/notifications': (
      <Badge variant={activeChannels.length > 0 ? 'ok' : 'secondary'}>
        {activeChannels.length > 0 ? 'branchées' : 'aucun canal'}
      </Badge>
    ),
    '/admin/settings/ia': <AiStatusBadge settings={settings} storedApiKey={aiApiKey} />,
  };

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {SETTINGS_SECTIONS.map((section) => {
        const Icon = section.icon;
        return (
          <Card key={section.href} className="gap-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span aria-hidden className="text-ink-faint">
                  <Icon className="size-4" />
                </span>
                {section.title}
                {badges[section.href] ?? null}
              </CardTitle>
              <CardDescription>{section.governs}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <dl className="grid gap-x-6 gap-y-1.5 text-[0.8125rem]">
                {(readouts[section.href] ?? []).map((row) => (
                  <div
                    key={row.term}
                    className="flex justify-between gap-3 border-b border-line pb-1.5"
                  >
                    <dt className="shrink-0 text-ink-muted">{row.term}</dt>
                    <dd className="min-w-0 truncate text-right font-mono text-ink">{row.value}</dd>
                  </div>
                ))}
              </dl>
              <Link
                href={section.href}
                className="inline-flex w-fit items-center gap-1.5 rounded-md text-[0.8125rem] font-medium text-signal underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Ouvrir {section.label.toLowerCase()}
                <ArrowRight aria-hidden className="size-3.5" />
              </Link>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
