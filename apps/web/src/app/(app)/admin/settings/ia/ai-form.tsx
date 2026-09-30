'use client';

import { useState } from 'react';
import {
  AI_MODEL_TIER_LABELS,
  aiModelHint,
  aiModelMismatch,
  aiModelOptions,
  aiProviderDescriptor,
  aiProviderDescriptors,
  defaultAiModel,
  translator,
  type AiProvider,
  type AppSettings,
} from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useLanguage, useT } from '@/i18n/client';
import { settings as messages } from '@/i18n/messages/settings';
import { formatNumber, formatSettingsOf } from '@/lib/format';
import { SectionForm } from '../section-form';
import { useSettingsPatch, type SettingsPatchBody } from '../use-settings-patch';

/**
 * Configuration du fournisseur d'IA, clé comprise.
 *
 * Fournisseur, modèle et clé ne se règlent jamais séparément — changer de
 * fournisseur invalide la clé du précédent — d'où une seule section pour les
 * trois, et un seul enregistrement.
 *
 * La clé garde ses **trois cas distincts**, tenus jusqu'au corps de la requête :
 *   propriété absente → clé inchangée (champ laissé vide)
 *   `null`            → clé effacée (case « Effacer » cochée)
 *   chaîne            → clé remplacée
 * Elle n'est jamais rendue : le serveur n'expose que `aiApiKeyConfigured` et
 * les quatre derniers caractères, et rien d'autre ne descend jusqu'ici.
 */
export function AiForm({
  settings,
  aiApiKeyConfigured,
  aiApiKeyLast4,
  canManage,
}: {
  settings: AppSettings;
  aiApiKeyConfigured: boolean;
  aiApiKeyLast4: string | null;
  canManage: boolean;
}) {
  const t = useT(messages);
  const language = useLanguage();
  const patch = useSettingsPatch();

  // Le cran d'un modèle est un catalogue de `@pupitre/core`, rendu comme les
  // descriptions de permissions : le dictionnaire vit à côté de la donnée,
  // l'écran ne fait que lui donner la langue de l'instance.
  const tierLabel = translator(AI_MODEL_TIER_LABELS, language);

  // Le prix est deux nombres : « 0,10 / 0,40 » ici, « 0.10 / 0.40 » sur une
  // instance anglaise. Deux décimales toujours, sinon la colonne se déchausse.
  const format = formatSettingsOf(settings);
  const price = (amounts: readonly [number, number]) =>
    amounts
      .map((amount) =>
        formatNumber(amount, format, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      )
      .join(' / ');

  const [enabled, setEnabled] = useState(settings.ai.enabled);
  const [provider, setProvider] = useState<AiProvider>(settings.ai.provider);
  const [model, setModel] = useState(settings.ai.model);
  const [baseUrl, setBaseUrl] = useState(settings.ai.baseUrl);
  const [temperature, setTemperature] = useState(String(settings.ai.temperature));
  const [maxTokens, setMaxTokens] = useState(String(settings.ai.maxTokens));

  /** Vide = clé inchangée. Renseigné = clé remplacée. */
  const [apiKeyInput, setApiKeyInput] = useState('');
  /** Coché = clé effacée à l'enregistrement. Distinct de « champ vide ». */
  const [clearApiKey, setClearApiKey] = useState(false);

  const descriptor = aiProviderDescriptor(provider);
  // Prévenir, pas interdire : un modèle sorti la semaine dernière ou une URL de
  // base personnalisée peuvent parfaitement démentir cette heuristique.
  const warning = aiModelMismatch(provider, model, { baseUrl, language });
  const suggestedModels = aiModelOptions(provider);

  /**
   * Changer de fournisseur emmène le modèle par défaut du nouveau fournisseur —
   * mais seulement si le champ portait encore le défaut du précédent. Un
   * identifiant choisi à la main n'est jamais écrasé : on le laisse, et
   * l'avertissement ci-dessus dit s'il est incohérent.
   */
  function switchProvider(next: AiProvider) {
    if (model.trim() === defaultAiModel(provider) || model.trim() === '') {
      setModel(defaultAiModel(next));
    }
    setProvider(next);
  }

  function reset() {
    setEnabled(settings.ai.enabled);
    setProvider(settings.ai.provider);
    setModel(settings.ai.model);
    setBaseUrl(settings.ai.baseUrl);
    setTemperature(String(settings.ai.temperature));
    setMaxTokens(String(settings.ai.maxTokens));
    setApiKeyInput('');
    setClearApiKey(false);
    patch.clearFeedback();
  }

  async function submit() {
    const body: SettingsPatchBody = {
      ai: {
        enabled,
        provider,
        model,
        // L'URL de base n'a de sens que pour les fournisseurs qui la déclarent.
        // L'envoyer quand même laisserait en base un réglage sans effet, que le
        // prochain lecteur croirait appliqué.
        baseUrl: descriptor.supportsBaseUrl ? baseUrl.trim() : '',
        temperature: Number(temperature),
        maxTokens: Number(maxTokens),
      },
    };

    // Les trois cas de la clé, tenus jusqu'au corps de la requête : la
    // propriété n'est présente que si l'on veut vraiment changer quelque chose.
    if (clearApiKey) body.aiApiKey = null;
    else if (apiKeyInput.trim() !== '') body.aiApiKey = apiKeyInput.trim();

    const ok = await patch.save(body);
    if (!ok) return;
    setApiKeyInput('');
    setClearApiKey(false);
  }

  return (
    <SectionForm patch={patch} canManage={canManage} onReset={reset} onSubmit={() => void submit()}>
      <label className="flex items-start gap-2.5 rounded-md border border-border px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={enabled}
          disabled={!canManage}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <span className="min-w-0">
          <span className="block text-text">{t('ai.enabled.label')}</span>
          <span className="help block">{t('ai.enabled.help')}</span>
        </span>
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="field">
          <Label htmlFor="aiProvider">{t('ai.provider.label')}</Label>
          <Select
            id="aiProvider"
            value={provider}
            disabled={!canManage}
            onChange={(event) => switchProvider(event.target.value as AiProvider)}
          >
            {aiProviderDescriptors().map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </Select>
          <p className="help">
            {t('ai.provider.help.before')}
            {descriptor.envApiKeyVar ? (
              <>
                {' '}
                (<code className="mono">{descriptor.envApiKeyVar}</code>)
              </>
            ) : null}
            {t('ai.provider.help.after')}
          </p>
        </div>
        <div className="field">
          <Label htmlFor="aiModel">{t('ai.model.label')}</Label>
          <Select
            id="aiModel"
            value={suggestedModels.some((option) => option.id === model) ? model : ''}
            disabled={!canManage}
            onChange={(event) => {
              // La chaîne vide est l'entrée « autre » : on ne l'écrit pas
              // dans le réglage, on rend la main au champ libre.
              if (event.target.value !== '') setModel(event.target.value);
            }}
          >
            {suggestedModels.map((option) => (
              <option key={option.id} value={option.id}>
                {option.id} — {tierLabel(option.tier)} · {price(option.price)} $/M
              </option>
            ))}
            <option value="">{t('ai.model.other')}</option>
          </Select>
          <Input
            id="aiModelCustom"
            aria-label={t('ai.model.aria')}
            value={model}
            maxLength={120}
            disabled={!canManage}
            onChange={(event) => setModel(event.target.value)}
          />
          <p className="help">{t('ai.model.help', { hint: aiModelHint(provider, language) })}</p>
        </div>
        <div className="field">
          <Label htmlFor="temperature">{t('ai.temperature.label')}</Label>
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
          <p className="help">{t('ai.temperature.help')}</p>
        </div>
        <div className="field">
          <Label htmlFor="maxTokens">{t('ai.maxTokens.label')}</Label>
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
          <p className="help">{t('ai.maxTokens.help')}</p>
        </div>
      </div>

      {warning ? <Alert variant="destructive">{warning}</Alert> : null}

      {descriptor.supportsBaseUrl ? (
        <div className="field">
          <Label htmlFor="aiBaseUrl">{t('ai.baseUrl.label')}</Label>
          <Input
            id="aiBaseUrl"
            value={baseUrl}
            maxLength={300}
            placeholder={t('ai.baseUrl.placeholder')}
            disabled={!canManage}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <p className="help">{t('ai.baseUrl.help')}</p>
        </div>
      ) : null}

      <div className="field border-t border-border-subtle pt-4">
        <Label htmlFor="apiKey">{t('ai.apiKey.label')}</Label>
        <Input
          id="apiKey"
          type="password"
          autoComplete="off"
          value={apiKeyInput}
          disabled={!canManage || clearApiKey}
          placeholder={
            aiApiKeyConfigured
              ? aiApiKeyLast4
                ? t('ai.apiKey.placeholder.setWithTail', { last4: aiApiKeyLast4 })
                : t('ai.apiKey.placeholder.set')
              : t('ai.apiKey.placeholder.none')
          }
          onChange={(event) => setApiKeyInput(event.target.value)}
        />
        <p className="help">
          {t('ai.apiKey.help.before')} <code className="mono">MASTER_KEY</code>
          {t('ai.apiKey.help.middle')}{' '}
          {descriptor.envApiKeyVar ? (
            <code className="mono">{descriptor.envApiKeyVar}</code>
          ) : (
            t('ai.apiKey.help.noEnvVar')
          )}
          {t('ai.apiKey.help.after', { provider: descriptor.label })}
        </p>
        {aiApiKeyConfigured && canManage ? (
          <label className="flex items-center gap-2 pt-1 text-xs text-text-2">
            <input
              type="checkbox"
              checked={clearApiKey}
              onChange={(event) => setClearApiKey(event.target.checked)}
            />
            {t('ai.apiKey.clear')}
          </label>
        ) : null}
      </div>
    </SectionForm>
  );
}
