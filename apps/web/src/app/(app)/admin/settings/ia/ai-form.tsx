'use client';

import { useState } from 'react';
import {
  AI_MODEL_TIER_LABELS,
  aiModelMismatch,
  aiModelOptions,
  aiProviderDescriptor,
  aiProviderDescriptors,
  defaultAiModel,
  type AiProvider,
  type AppSettings,
} from '@tp/core';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
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
  const patch = useSettingsPatch();

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
  const warning = aiModelMismatch(provider, model, { baseUrl });
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
      <label className="flex items-start gap-2.5 rounded-md border border-line px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={enabled}
          disabled={!canManage}
          onChange={(event) => setEnabled(event.target.checked)}
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
          <p className="text-xs text-ink-faint">
            Chaque fournisseur lit sa propre variable d&apos;environnement de repli
            {descriptor.envApiKeyVar ? (
              <>
                {' '}
                (<code className="font-mono">{descriptor.envApiKeyVar}</code>)
              </>
            ) : null}
            . Une clé enregistrée ici la remplace.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="aiModel">Modèle</Label>
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
                {option.id} — {AI_MODEL_TIER_LABELS[option.tier]} · {option.price} $/M
              </option>
            ))}
            <option value="">Autre — saisir un identifiant</option>
          </Select>
          <Input
            id="aiModelCustom"
            aria-label="Identifiant du modèle"
            value={model}
            maxLength={120}
            disabled={!canManage}
            onChange={(event) => setModel(event.target.value)}
          />
          <p className="text-xs text-ink-faint">
            {descriptor.modelHint}. Prix indicatifs en dollars par million de jetons, entrée puis
            sortie, relevés le 11/09/2026 — ils vieillissent, et la liste n&apos;est qu&apos;une
            suggestion : tout identifiant reconnu par le fournisseur convient, y compris un modèle
            sorti après cette liste.
          </p>
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
          <p className="text-xs text-ink-faint">
            Basse, la génération est reproductible — ce qu&apos;on veut d&apos;une AppSpec.
          </p>
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
          <p className="text-xs text-ink-faint">
            Plafond d&apos;une réponse. Trop bas, le JSON est tronqué et la validation échoue.
          </p>
        </div>
      </div>

      {warning ? <Alert variant="destructive">{warning}</Alert> : null}

      {descriptor.supportsBaseUrl ? (
        <div className="space-y-1.5">
          <Label htmlFor="aiBaseUrl">URL de base (facultatif)</Label>
          <Input
            id="aiBaseUrl"
            value={baseUrl}
            maxLength={300}
            placeholder="https://llm.interne.example/v1"
            disabled={!canManage}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <p className="text-xs text-ink-faint">
            Pour une API compatible OpenAI auto-hébergée. Laissée vide, c&apos;est l&apos;API
            publique du fournisseur qui est appelée. L&apos;URL est validée à l&apos;enregistrement :
            une valeur bancale ferait échouer chaque génération sans rien dire.
          </p>
        </div>
      ) : null}

      <div className="space-y-1.5 border-t border-line pt-4">
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
          credentials SSH. Elle n&apos;est jamais renvoyée par l&apos;API ni écrite dans le journal
          d&apos;audit — ce champ part toujours vide, même quand une clé est en place. Sans clé
          ici, le panel retombe sur{' '}
          {descriptor.envApiKeyVar ? (
            <code className="font-mono">{descriptor.envApiKeyVar}</code>
          ) : (
            'aucune variable d’environnement'
          )}
          , la variable propre à {descriptor.label}.
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
    </SectionForm>
  );
}
