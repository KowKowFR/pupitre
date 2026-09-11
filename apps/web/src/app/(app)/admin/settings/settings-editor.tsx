'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FAIL_ON_LABELS, SCANNER_KEYS, failOnSchema, scannerLabel, type FailOn, type ScannerKey } from '@tp/core';
import type { AppSettings, DateStyleName, SupportedLocale } from '@tp/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { formatDateTime } from '@/lib/format';

type Props = {
  settings: AppSettings;
  aiApiKeyConfigured: boolean;
  aiApiKeyLast4: string | null;
  timezones: string[];
  locales: SupportedLocale[];
  dateStyles: DateStyleName[];
  canManage: boolean;
};

type ApiError = { error?: { message?: string; details?: unknown } };

/**
 * Instant de référence de l'aperçu.
 *
 * Fixe, et non `new Date()` : l'aperçu est rendu côté serveur puis réhydraté
 * côté client, et deux appels à `new Date()` séparés de quelques centaines de
 * millisecondes produiraient deux chaînes différentes — donc une erreur
 * d'hydratation. Un instant figé montre exactement ce qu'on veut montrer : le
 * décalage du fuseau et la forme du rendu.
 */
const PREVIEW_INSTANT = new Date('2026-01-15T14:32:07Z');

const DATE_STYLE_LABEL: Record<DateStyleName, string> = {
  short: 'court',
  medium: 'moyen',
  long: 'long',
};

export function SettingsEditor({
  settings,
  aiApiKeyConfigured,
  aiApiKeyLast4,
  timezones,
  locales,
  dateStyles,
  canManage,
}: Props) {
  const router = useRouter();

  const [instanceName, setInstanceName] = useState(settings.instanceName);
  const [instanceTagline, setInstanceTagline] = useState(settings.instanceTagline);
  const [timezone, setTimezone] = useState(settings.timezone);
  const [locale, setLocale] = useState<SupportedLocale>(settings.locale);
  const [dateStyle, setDateStyle] = useState<DateStyleName>(settings.dateStyle);
  const [timeStyle, setTimeStyle] = useState<DateStyleName>(settings.timeStyle);

  const [aiEnabled, setAiEnabled] = useState(settings.ai.enabled);
  const [aiModel, setAiModel] = useState(settings.ai.model);
  const [temperature, setTemperature] = useState(String(settings.ai.temperature));
  const [maxTokens, setMaxTokens] = useState(String(settings.ai.maxTokens));

  const [scanningEnabled, setScanningEnabled] = useState(settings.security.scanningEnabled);
  const [disabledScanners, setDisabledScanners] = useState<ScannerKey[]>(
    settings.security.disabledScanners,
  );
  const [failOn, setFailOn] = useState<FailOn>(settings.security.failOn);

  /** Vide = clé inchangée. Renseigné = clé remplacée. */
  const [apiKeyInput, setApiKeyInput] = useState('');
  /** Coché = clé effacée à l'enregistrement. Distinct de « champ vide ». */
  const [clearApiKey, setClearApiKey] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const preview = formatDateTime(PREVIEW_INSTANT, { timezone, locale, dateStyle, timeStyle });

  async function save() {
    setPending(true);
    setError(null);
    setNotice(null);

    const body: Record<string, unknown> = {
      instanceName,
      instanceTagline,
      timezone,
      locale,
      dateStyle,
      timeStyle,
      ai: {
        enabled: aiEnabled,
        model: aiModel,
        temperature: Number(temperature),
        maxTokens: Number(maxTokens),
      },
      security: { scanningEnabled, disabledScanners, failOn },
    };

    // Les trois cas de la clé, tenus jusqu'au corps de la requête : la
    // propriété n'est présente que si l'on veut vraiment changer quelque chose.
    if (clearApiKey) body.aiApiKey = null;
    else if (apiKeyInput.trim() !== '') body.aiApiKey = apiKeyInput.trim();

    const response = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as ApiError;
      setError(payload.error?.message ?? `Échec (HTTP ${response.status})`);
      setPending(false);
      return;
    }

    setApiKeyInput('');
    setClearApiKey(false);
    setNotice('Paramètres enregistrés.');
    setPending(false);
    router.refresh();
  }

  function reset() {
    setInstanceName(settings.instanceName);
    setInstanceTagline(settings.instanceTagline);
    setTimezone(settings.timezone);
    setLocale(settings.locale);
    setDateStyle(settings.dateStyle);
    setTimeStyle(settings.timeStyle);
    setScanningEnabled(settings.security.scanningEnabled);
    setDisabledScanners(settings.security.disabledScanners);
    setFailOn(settings.security.failOn);
    setAiEnabled(settings.ai.enabled);
    setAiModel(settings.ai.model);
    setTemperature(String(settings.ai.temperature));
    setMaxTokens(String(settings.ai.maxTokens));
    setApiKeyInput('');
    setClearApiKey(false);
    setError(null);
    setNotice(null);
  }

  return (
    <div className="flex flex-col gap-5">
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {notice ? <Alert variant="success">{notice}</Alert> : null}
      {canManage ? null : (
        <Alert>
          Lecture seule : la permission <code className="font-mono text-xs">settings:manage</code>{' '}
          est requise pour modifier ces réglages.
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Identité</CardTitle>
          <CardDescription>
            Ce que le panel affiche de lui-même : en haut à gauche du rail, et dans le titre de
            l&apos;onglet du navigateur.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="instanceName">Nom de l&apos;instance</Label>
            <Input
              id="instanceName"
              value={instanceName}
              maxLength={40}
              disabled={!canManage}
              onChange={(event) => setInstanceName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="instanceTagline">Sous-titre</Label>
            <Input
              id="instanceTagline"
              value={instanceTagline}
              maxLength={60}
              disabled={!canManage}
              placeholder="Laisser vide pour n'afficher que le nom"
              onChange={(event) => setInstanceTagline(event.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Régionalisation</CardTitle>
          <CardDescription>
            Toutes les dates du panel sont rendues avec ce fuseau et cette locale, serveur et
            navigateur compris. Le fuseau est toujours explicite : c&apos;est ce qui garantit que
            les deux affichent la même chose.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="timezone">Fuseau horaire</Label>
              <Select
                id="timezone"
                value={timezone}
                disabled={!canManage}
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
              <Label htmlFor="locale">Locale</Label>
              <Select
                id="locale"
                value={locale}
                disabled={!canManage}
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
              <Label htmlFor="dateStyle">Style de date</Label>
              <Select
                id="dateStyle"
                value={dateStyle}
                disabled={!canManage}
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
              <Label htmlFor="timeStyle">Style d&apos;heure</Label>
              <Select
                id="timeStyle"
                value={timeStyle}
                disabled={!canManage}
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Intelligence artificielle
            <Badge variant={aiEnabled ? 'ok' : 'secondary'}>
              {aiEnabled ? 'activée' : 'désactivée'}
            </Badge>
          </CardTitle>
          <CardDescription>
            Génération d&apos;AppSpec à partir d&apos;une description. Le modèle ne produit jamais
            de shell : il rend du JSON, validé par Zod avant que quoi que ce soit ne soit exécuté.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <label className="flex items-start gap-2.5 rounded-md border border-line px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={aiEnabled}
              disabled={!canManage}
              onChange={(event) => setAiEnabled(event.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-ink">Autoriser la génération par IA</span>
              <span className="block text-xs text-ink-faint">
                Interrupteur explicite : décocher coupe la génération même si une clé est
                enregistrée.
              </span>
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="aiProvider">Fournisseur</Label>
              <Input id="aiProvider" value={settings.ai.provider} readOnly disabled />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="aiModel">Modèle</Label>
              <Input
                id="aiModel"
                value={aiModel}
                maxLength={120}
                disabled={!canManage}
                onChange={(event) => setAiModel(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="temperature">Température (0 à 1)</Label>
              <Input
                id="temperature"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={temperature}
                disabled={!canManage}
                onChange={(event) => setTemperature(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="maxTokens">Jetons maximum</Label>
              <Input
                id="maxTokens"
                type="number"
                min={256}
                max={200000}
                step={256}
                value={maxTokens}
                disabled={!canManage}
                onChange={(event) => setMaxTokens(event.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="apiKey">Clé d&apos;API</Label>
            <Input
              id="apiKey"
              type="password"
              autoComplete="off"
              value={apiKeyInput}
              disabled={!canManage || clearApiKey}
              placeholder={
                aiApiKeyConfigured
                  ? `Clé enregistrée${aiApiKeyLast4 ? ` — …${aiApiKeyLast4}` : ''}, laisser vide pour la conserver`
                  : 'Aucune clé enregistrée'
              }
              onChange={(event) => setApiKeyInput(event.target.value)}
            />
            <p className="text-xs text-ink-faint">
              Chiffrée en AES-256-GCM sous <code className="font-mono">MASTER_KEY</code>, comme les
              credentials SSH. Elle n&apos;est jamais renvoyée par l&apos;API ni écrite dans le
              journal d&apos;audit. Sans clé ici, le panel retombe sur{' '}
              <code className="font-mono">OPENROUTER_API_KEY</code>.
            </p>
            {aiApiKeyConfigured && canManage ? (
              <label className="flex items-center gap-2 pt-1 text-xs text-ink-muted">
                <input
                  type="checkbox"
                  checked={clearApiKey}
                  onChange={(event) => setClearApiKey(event.target.checked)}
                />
                Effacer la clé enregistrée
              </label>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Analyse de sécurité
            <Badge variant={scanningEnabled ? 'ok' : 'destructive'}>
              {scanningEnabled ? 'active' : 'désactivée'}
            </Badge>
          </CardTitle>
          <CardDescription>
            Scan des images avant mise en ligne. Le réglage est permanent : il s&apos;applique à
            tous les déploiements à venir, y compris ceux lancés depuis l&apos;API, jusqu&apos;à ce
            qu&apos;on le remette.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <label className="flex items-start gap-2.5 rounded-md border border-line px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={scanningEnabled}
              disabled={!canManage}
              onChange={(event) => setScanningEnabled(event.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-ink">Analyser les images avant déploiement</span>
              <span className="block text-xs text-ink-faint">
                Décocher coupe l&apos;étape pour tout le monde, même si un déploiement demande
                explicitement des scanners.
              </span>
            </span>
          </label>

          {scanningEnabled ? null : (
            <Alert variant="destructive">
              Plus aucune image ne sera analysée. Les vulnérabilités connues des dépendances de vos
              applications passeront sans être signalées, et le seuil de blocage devient sans effet.
            </Alert>
          )}

          <div className="space-y-2">
            <span className="block text-sm text-ink">Scanners écartés</span>
            <p className="text-xs text-ink-faint">
              Utile quand un seul scanner pose problème — une base de vulnérabilités inaccessible
              depuis la machine cible, par exemple. Les autres continuent de tourner.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
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
                      disabled={!canManage || !scanningEnabled}
                      onChange={(event) => {
                        setDisabledScanners((current) =>
                          event.target.checked
                            ? [...current, key]
                            : current.filter((entry) => entry !== key),
                        );
                      }}
                    />
                    <span className={off ? 'text-ink-faint line-through' : 'text-ink'}>
                      {scannerLabel(key)}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="failOn">Seuil de blocage</Label>
            <Select
              id="failOn"
              className="w-full sm:w-72"
              value={failOn}
              disabled={!canManage || !scanningEnabled}
              onChange={(event) => setFailOn(failOnSchema.parse(event.target.value))}
            >
              {failOnSchema.options.map((option) => (
                <option key={option} value={option}>
                  {FAIL_ON_LABELS[option]}
                </option>
              ))}
            </Select>
            <p className="text-ink-faint text-xs">
              Sévérité à partir de laquelle un finding empêche la mise en ligne. Ce seuil vaut pour
              toute l&apos;instance : l&apos;écran de déploiement ne le demande plus, une politique
              de sécurité qui se rediscute à chaque mise en ligne n&apos;en est pas une.
            </p>
          </div>

          <p className="text-xs text-ink-faint">
            Le réglage s&apos;applique au moment où un déploiement est enfilé, et la configuration
            retenue est gelée avec lui : réactiver l&apos;analyse ne relance pas ce qui est déjà en
            file. Chaque modification est tracée dans le journal d&apos;audit.
          </p>
        </CardContent>
      </Card>

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={pending} onClick={() => void save()}>
            {pending ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={reset}>
            Annuler
          </Button>
        </div>
      ) : null}
    </div>
  );
}
