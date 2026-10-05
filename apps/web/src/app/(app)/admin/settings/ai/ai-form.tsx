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
import { HelpTip } from '@/components/ui/help-tip';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useLanguage, useT } from '@/i18n/client';
import { settings as messages } from '@/i18n/messages/settings';
import { formatNumber, formatSettingsOf } from '@/lib/format';
import { SectionForm } from '../section-form';
import { useSettingsPatch, type SettingsPatchBody } from '../use-settings-patch';

/**
 * The AI provider's configuration, key included.
 *
 * Provider, model and key are never set separately — changing provider
 * invalidates the previous one's key — hence a single section for the three, and
 * a single save.
 *
 * The key keeps its **three distinct cases**, held all the way to the request
 * body:
 *   absent property → key unchanged (field left empty)
 *   `null`          → key cleared ("Clear" box checked)
 *   string          → key replaced
 * It is never rendered: the server only exposes `aiApiKeyConfigured` and the
 * last four characters, and nothing else comes down here.
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

  // A model's tier is a `@pupitre/core` catalog, rendered like the permission
  // descriptions: the dictionary lives next to the data, the screen only gives it
  // the instance's language.
  const tierLabel = translator(AI_MODEL_TIER_LABELS, language);

  // The price is two numbers: "0,10 / 0,40" here, "0.10 / 0.40" on an English
  // instance. Always two decimals, otherwise the column comes apart.
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

  /** Empty = key unchanged. Filled in = key replaced. */
  const [apiKeyInput, setApiKeyInput] = useState('');
  /** Checked = key cleared on save. Distinct from "empty field". */
  const [clearApiKey, setClearApiKey] = useState(false);

  const descriptor = aiProviderDescriptor(provider);
  // Warn, not forbid: a model released last week or a custom base URL may very
  // well contradict this heuristic.
  const warning = aiModelMismatch(provider, model, { baseUrl, language });
  const suggestedModels = aiModelOptions(provider);

  /**
   * Changing provider brings along the new provider's default model — but only if
   * the field still carried the previous one's default. An identifier chosen by
   * hand is never overwritten: we leave it, and the warning above says whether it
   * is inconsistent.
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
        // The base URL only makes sense for the providers that declare it. Sending it
        // anyway would leave in the database a setting without effect, which the next
        // reader would believe applied.
        baseUrl: descriptor.supportsBaseUrl ? baseUrl.trim() : '',
        temperature: Number(temperature),
        maxTokens: Number(maxTokens),
      },
    };

    // The key's three cases, held all the way to the request body: the property is
    // only present if one really wants to change something.
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
          <span className="block text-text">
            {t('ai.enabled.label')}
            <HelpTip>{t('ai.enabled.help')}</HelpTip>
          </span>
        </span>
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="field">
          <Label htmlFor="aiProvider">
            {t('ai.provider.label')}
            <HelpTip>
              {t('ai.provider.help.before')}
              {descriptor.envApiKeyVar ? (
                <>
                  {' '}
                  (<code className="mono">{descriptor.envApiKeyVar}</code>)
                </>
              ) : null}
              {t('ai.provider.help.after')}
            </HelpTip>
          </Label>
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
        </div>
        <div className="field">
          <Label htmlFor="aiModel">
            {t('ai.model.label')}
            <HelpTip>{t('ai.model.help', { hint: aiModelHint(provider, language) })}</HelpTip>
          </Label>
          <Select
            id="aiModel"
            value={suggestedModels.some((option) => option.id === model) ? model : ''}
            disabled={!canManage}
            onChange={(event) => {
              // The empty string is the "other" entry: it is not written into the setting,
              // control goes back to the free field.
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
        </div>
        <div className="field">
          <Label htmlFor="temperature">
            {t('ai.temperature.label')}
            <HelpTip>{t('ai.temperature.help')}</HelpTip>
          </Label>
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
        <div className="field">
          <Label htmlFor="maxTokens">
            {t('ai.maxTokens.label')}
            <HelpTip>{t('ai.maxTokens.help')}</HelpTip>
          </Label>
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

      {warning ? <Alert variant="destructive">{warning}</Alert> : null}

      {descriptor.supportsBaseUrl ? (
        <div className="field">
          <Label htmlFor="aiBaseUrl">
            {t('ai.baseUrl.label')}
            <HelpTip>{t('ai.baseUrl.help')}</HelpTip>
          </Label>
          <Input
            id="aiBaseUrl"
            value={baseUrl}
            maxLength={300}
            placeholder={t('ai.baseUrl.placeholder')}
            disabled={!canManage}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </div>
      ) : null}

      <div className="field border-t border-border-subtle pt-4">
        <Label htmlFor="apiKey">
          {t('ai.apiKey.label')}
          <HelpTip>
            {t('ai.apiKey.help.before')} <code className="mono">MASTER_KEY</code>
            {t('ai.apiKey.help.middle')}{' '}
            {descriptor.envApiKeyVar ? (
              <code className="mono">{descriptor.envApiKeyVar}</code>
            ) : (
              t('ai.apiKey.help.noEnvVar')
            )}
            {t('ai.apiKey.help.after', { provider: descriptor.label })}
          </HelpTip>
        </Label>
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
