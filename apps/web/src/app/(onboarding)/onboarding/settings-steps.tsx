'use client';

import { useState } from 'react';
import { SCANNER_KEYS, scannerLabel, type ScannerKey } from '@tp/core';
import type { AppSettings, DateStyleName, SupportedLocale } from '@tp/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { formatDateTime } from '@/lib/format';

/**
 * Les deux étapes qui n'ont pas de formulaire à réutiliser : elles écrivent
 * dans les paramètres d'instance, et `PATCH /api/settings` accepte un patch
 * *partiel*. C'est ce qui permet à l'assistant de n'envoyer que ce qu'il montre
 * — le fuseau ici, les scanners là — sans réinitialiser au passage un réglage
 * qu'il n'affiche pas. Aucune validation n'est refaite côté client : le schéma
 * Zod de la route reste le seul juge.
 */

type ApiError = { error?: { message?: string } };

/** Instant fixe : deux `new Date()` séparés produiraient deux rendus différents. */
const PREVIEW_INSTANT = new Date('2026-01-15T14:32:07Z');

const DATE_STYLE_LABEL: Record<DateStyleName, string> = {
  short: 'court',
  medium: 'moyen',
  long: 'long',
};

async function patchSettings(body: Record<string, unknown>): Promise<string | null> {
  const response = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.ok) return null;
  const payload = (await response.json().catch(() => ({}))) as ApiError;
  return payload.error?.message ?? `Échec (HTTP ${response.status})`;
}

export function IdentityStep({
  settings,
  timezones,
  locales,
  dateStyles,
  disabled,
  onSaved,
}: {
  settings: AppSettings;
  timezones: string[];
  locales: SupportedLocale[];
  dateStyles: DateStyleName[];
  disabled: boolean;
  onSaved: () => void;
}) {
  const [instanceName, setInstanceName] = useState(settings.instanceName);
  const [instanceTagline, setInstanceTagline] = useState(settings.instanceTagline);
  const [timezone, setTimezone] = useState(settings.timezone);
  const [locale, setLocale] = useState<SupportedLocale>(settings.locale);
  const [dateStyle, setDateStyle] = useState<DateStyleName>(settings.dateStyle);
  const [timeStyle, setTimeStyle] = useState<DateStyleName>(settings.timeStyle);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const preview = formatDateTime(PREVIEW_INSTANT, { timezone, locale, dateStyle, timeStyle });

  async function save() {
    setPending(true);
    const message = await patchSettings({
      instanceName,
      instanceTagline,
      timezone,
      locale,
      dateStyle,
      timeStyle,
    });
    setError(message);
    setPending(false);
    if (!message) onSaved();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[0.8125rem] leading-relaxed text-ink-muted">
        Le nom s&apos;affiche en haut à gauche et dans le titre de l&apos;onglet. Le fuseau, lui,
        n&apos;est pas cosmétique : toutes les dates du panel sont rendues avec, serveur et
        navigateur compris, pour que les deux affichent la même chose.
      </p>

      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ob-name">Nom de l&apos;instance</Label>
          <Input
            id="ob-name"
            value={instanceName}
            maxLength={40}
            onChange={(event) => setInstanceName(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ob-tagline">Sous-titre</Label>
          <Input
            id="ob-tagline"
            value={instanceTagline}
            maxLength={60}
            placeholder="Laisser vide pour n'afficher que le nom"
            onChange={(event) => setInstanceTagline(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ob-timezone">Fuseau horaire</Label>
          <Select
            id="ob-timezone"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
          >
            {timezones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ob-locale">Locale</Label>
          <Select
            id="ob-locale"
            value={locale}
            onChange={(event) => setLocale(event.target.value as SupportedLocale)}
          >
            {locales.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ob-date-style">Style de date</Label>
          <Select
            id="ob-date-style"
            value={dateStyle}
            onChange={(event) => setDateStyle(event.target.value as DateStyleName)}
          >
            {dateStyles.map((style) => (
              <option key={style} value={style}>
                {DATE_STYLE_LABEL[style]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ob-time-style">Style d&apos;heure</Label>
          <Select
            id="ob-time-style"
            value={timeStyle}
            onChange={(event) => setTimeStyle(event.target.value as DateStyleName)}
          >
            {dateStyles.map((style) => (
              <option key={style} value={style}>
                {DATE_STYLE_LABEL[style]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="rounded-md border border-line bg-surface-2 px-3.5 py-3">
        <div className="eyebrow text-ink-faint">Aperçu</div>
        <div className="mt-1 font-mono text-sm text-ink tabular-nums">{preview}</div>
        <div className="mt-1 text-xs text-ink-faint">
          Instant de référence : 2026-01-15 14:32:07 UTC
        </div>
      </div>

      <div>
        <Button size="sm" disabled={pending || disabled} onClick={() => void save()}>
          {pending ? 'Enregistrement…' : 'Enregistrer et continuer'}
        </Button>
      </div>
    </div>
  );
}

export function SecurityStep({
  settings,
  aiApiKeyConfigured,
  aiApiKeyLast4,
  disabled,
  onSaved,
}: {
  settings: AppSettings;
  aiApiKeyConfigured: boolean;
  aiApiKeyLast4: string | null;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [scanningEnabled, setScanningEnabled] = useState(settings.security.scanningEnabled);
  const [disabledScanners, setDisabledScanners] = useState<ScannerKey[]>(
    settings.security.disabledScanners,
  );
  const [aiEnabled, setAiEnabled] = useState(settings.ai.enabled);
  /** Jamais préremplie : la clé ne ressort pas de la base, même masquée. */
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save() {
    setPending(true);
    const body: Record<string, unknown> = {
      security: { scanningEnabled, disabledScanners },
      ai: { enabled: aiEnabled },
    };
    // Champ vide = clé inchangée. La propriété n'est présente que si l'on veut
    // vraiment poser une clé — même distinction qu'à l'écran des paramètres.
    if (apiKeyInput.trim() !== '') body.aiApiKey = apiKeyInput.trim();

    const message = await patchSettings(body);
    setError(message);
    setPending(false);
    if (!message) {
      setApiKeyInput('');
      onSaved();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <label className="flex items-start gap-2.5 rounded-md border border-line px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={scanningEnabled}
          onChange={(event) => setScanningEnabled(event.target.checked)}
        />
        <span className="min-w-0">
          <span className="block text-ink">Analyser les images avant déploiement</span>
          <span className="block text-xs text-ink-faint">
            Trivy et Grype cherchent les vulnérabilités connues des dépendances, Syft dresse le
            SBOM. Le réglage s&apos;applique au moment où un déploiement est enfilé, et il est gelé
            avec lui.
          </span>
        </span>
      </label>

      {scanningEnabled ? (
        <div className="space-y-2">
          <span className="block text-sm text-ink">Scanners écartés</span>
          <div className="flex flex-wrap gap-2">
            {SCANNER_KEYS.map((key) => {
              const off = disabledScanners.includes(key);
              return (
                <label
                  key={key}
                  className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={off}
                    onChange={(event) =>
                      setDisabledScanners((current) =>
                        event.target.checked
                          ? [...current, key]
                          : current.filter((entry) => entry !== key),
                      )
                    }
                  />
                  <span className={off ? 'text-ink-faint line-through' : 'text-ink'}>
                    {scannerLabel(key)}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ) : (
        <Alert variant="destructive">
          Plus aucune image ne sera analysée. Les vulnérabilités connues des dépendances de vos
          applications passeront sans être signalées.
        </Alert>
      )}

      <label className="flex items-start gap-2.5 rounded-md border border-line px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={aiEnabled}
          onChange={(event) => setAiEnabled(event.target.checked)}
        />
        <span className="min-w-0">
          <span className="block text-ink">Autoriser la génération d&apos;AppSpec par IA</span>
          <span className="block text-xs text-ink-faint">
            Le modèle ne produit jamais de shell : il rend du JSON, validé par Zod avant que quoi
            que ce soit ne soit exécuté.
          </span>
        </span>
      </label>

      <div className="space-y-1.5">
        <Label htmlFor="ob-api-key">Clé d&apos;API du modèle</Label>
        <Input
          id="ob-api-key"
          type="password"
          autoComplete="off"
          value={apiKeyInput}
          placeholder={
            aiApiKeyConfigured
              ? `Clé déjà enregistrée${aiApiKeyLast4 ? ` — …${aiApiKeyLast4}` : ''}, laisser vide pour la conserver`
              : 'Laisser vide pour ne pas en poser'
          }
          onChange={(event) => setApiKeyInput(event.target.value)}
        />
        <p className="text-xs text-ink-faint">
          Chiffrée en AES-256-GCM sous <code className="font-mono">MASTER_KEY</code>, comme les
          credentials SSH. Elle ne ressort jamais de la base : ni par l&apos;API, ni dans les
          logs, ni ici. Pour en changer plus tard, on la remplace — on ne la relit pas.
        </p>
      </div>

      <div>
        <Button size="sm" disabled={pending || disabled} onClick={() => void save()}>
          {pending ? 'Enregistrement…' : 'Enregistrer et continuer'}
        </Button>
      </div>
    </div>
  );
}
