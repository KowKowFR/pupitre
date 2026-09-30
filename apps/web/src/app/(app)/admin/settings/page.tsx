import type { ReactNode } from 'react';
import Link from 'next/link';
import { SCANNER_KEYS, failOnLabel, scannerLabel } from '@pupitre/core';
import { getAiApiKey, getAppSettings, listNotificationChannels } from '@pupitre/db';
import { Badge } from '@/components/ui/badge';
import { KeyValue } from '@/components/ui/data';
import { currentLanguage, getT } from '@/i18n/server';
import { settings as messages } from '@/i18n/messages/settings';
import { formatDateTime, formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { SETTINGS_SECTIONS } from './sections';
import { AiStatusBadge } from './ai-status';

export const dynamic = 'force-dynamic';

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
  const t = await getT(messages);
  const language = await currentLanguage();
  // La clé ne descend jamais au client : elle sert ici, côté serveur, à savoir
  // si la génération est réellement possible — pas seulement autorisée.
  const aiApiKey = await getAiApiKey();
  const channels = await listNotificationChannels();
  const activeChannels = channels.filter((channel) => channel.enabled);

  const activeScanners = SCANNER_KEYS.filter(
    (key) => !settings.security.disabledScanners.includes(key),
  );

  const onboardingStatus = {
    pending: t('onboarding.status.pending'),
    in_progress: t('onboarding.status.inProgress'),
    dismissed: t('onboarding.status.dismissed'),
    completed: t('onboarding.status.completed'),
  } as const;

  const readouts: Record<string, { term: string; value: ReactNode }[]> = {
    '/admin/settings/identite': [
      { term: t('overview.term.name'), value: settings.instanceName },
      {
        term: t('overview.term.tagline'),
        value: settings.instanceTagline === '' ? '—' : settings.instanceTagline,
      },
    ],
    '/admin/settings/regionalisation': [
      {
        term: t('overview.term.timezone'),
        value: <span className="mono">{settings.timezone}</span>,
      },
      { term: t('overview.term.locale'), value: settings.locale },
      {
        term: t('overview.term.rendering'),
        value: (
          <span className="mono">
            {formatDateTime(PREVIEW_INSTANT, formatSettingsOf(settings))}
          </span>
        ),
      },
    ],
    '/admin/settings/securite': [
      {
        term: t('overview.term.activeScanners'),
        value: settings.security.scanningEnabled
          ? activeScanners.length === 0
            ? t('overview.scanners.none')
            : activeScanners.map(scannerLabel).join(', ')
          : t('overview.scanners.off'),
      },
      {
        term: t('overview.term.failOn'),
        value: failOnLabel(settings.security.failOn, language),
      },
    ],
    '/admin/settings/notifications': [
      {
        term: t('overview.term.channels'),
        value:
          channels.length === 0
            ? t('overview.channels.none')
            : t('overview.channels.active', {
                count: activeChannels.length,
                total: channels.length,
              }),
      },
      {
        term: t('overview.term.events'),
        value: String(new Set(activeChannels.flatMap((channel) => channel.events)).size),
      },
      {
        term: t('overview.term.failing'),
        value: (() => {
          const failing = channels.filter((channel) => channel.consecutiveFailures > 0).length;
          return failing > 0 ? <span className="text-danger-text">{failing}</span> : '0';
        })(),
      },
    ],
    '/admin/settings/ia': [
      { term: t('overview.term.provider'), value: settings.ai.provider },
      {
        term: t('overview.term.model'),
        value: <span className="mono">{settings.ai.model}</span>,
      },
      {
        term: t('overview.term.apiKey'),
        value: record.aiApiKeyConfigured
          ? record.aiApiKeyLast4
            ? t('overview.apiKey.setWithTail', { last4: record.aiApiKeyLast4 })
            : t('overview.apiKey.set')
          : t('overview.apiKey.none'),
      },
    ],
    '/admin/settings/demarrage': [
      { term: t('onboarding.term.status'), value: onboardingStatus[settings.onboarding.status] },
      { term: t('onboarding.term.currentStep'), value: settings.onboarding.currentStep },
      { term: t('onboarding.term.runs'), value: String(settings.onboarding.runs) },
    ],
  };

  const badges: Record<string, ReactNode> = {
    '/admin/settings/securite': (
      <Badge variant={settings.security.scanningEnabled ? 'ok' : 'danger'} dot>
        {settings.security.scanningEnabled ? t('security.badge.on') : t('security.badge.off')}
      </Badge>
    ),
    '/admin/settings/notifications': (
      <Badge variant={activeChannels.length > 0 ? 'ok' : 'idle'} dot>
        {activeChannels.length > 0
          ? t('overview.badge.channelsOn')
          : t('overview.badge.channelsOff')}
      </Badge>
    ),
    '/admin/settings/ia': <AiStatusBadge settings={settings} storedApiKey={aiApiKey} />,
  };

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {SETTINGS_SECTIONS.map((section) => {
        const Icon = section.icon;
        return (
          <section key={section.href} className="card flex flex-col overflow-hidden">
            <div className="card-h">
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-text-2"
              >
                <Icon className="size-4" />
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="flex flex-wrap items-center gap-2">
                  <h2>{t(`section.${section.id}.title`)}</h2>
                  {badges[section.href] ?? null}
                </span>
                <span className="sub" title={t(`section.${section.id}.governs`)}>
                  {t(`section.${section.id}.short`)}
                </span>
              </div>
            </div>
            <div className="card-b flex-1 !py-1">
              <KeyValue
                items={(readouts[section.href] ?? []).map((row) => ({
                  key: row.term,
                  term: row.term,
                  value: row.value,
                }))}
              />
            </div>
            <div className="card-f">
              <Link href={section.href} className="link t-cap">
                {t('overview.open', {
                  label: t(`section.${section.id}.label`).toLowerCase(),
                })}
              </Link>
            </div>
          </section>
        );
      })}
    </div>
  );
}
