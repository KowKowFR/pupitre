'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AppSpecHelpDialog } from '@/components/appspec-help';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * Création d'une application, par deux chemins qui aboutissent au même endroit.
 *
 * L'onglet « Depuis une description » ne fait qu'*alimenter* l'éditeur JSON :
 * la génération ne crée rien, ne déploie rien. C'est le même bouton
 * « Enregistrer » qui valide dans les deux cas, et la même route
 * `POST /api/applications`. L'IA propose ; l'opérateur dispose.
 */

const EXAMPLE = `{
  "name": "demo-api",
  "version": "1.0.0",
  "services": [
    {
      "name": "api",
      "source": { "type": "image", "ref": "docker.io/library/nginx:1.29-alpine" },
      "port": 80,
      "exposed": true,
      "healthcheck": { "path": "/", "intervalSec": 5, "timeoutSec": 3, "retries": 10 }
    }
  ]
}`;

type ApiError = {
  error?: {
    message?: string;
    details?: { fieldErrors?: Record<string, string[]>; issues?: string[]; model?: string };
  };
};

type GenerationOrigin = { prompt: string; model: string; appSpec: unknown };

type Tab = 'prompt' | 'json';

type Props = {
  /** `false` quand aucune OPENROUTER_API_KEY n'est configurée sur ce panel. */
  aiEnabled: boolean;
  model: string;
};

async function readError(response: Response): Promise<{ message: string; issues: string[] }> {
  const body = (await response.json().catch(() => ({}))) as ApiError;
  const message = body.error?.message ?? `Échec (HTTP ${response.status})`;

  // Deux formes d'erreur, une seule présentation : les reproches de Zod champ
  // par champ (création), et ceux de la validation d'AppSpec (génération).
  const fieldErrors = body.error?.details?.fieldErrors ?? {};
  const issues = [
    ...(body.error?.details?.issues ?? []),
    ...Object.entries(fieldErrors).flatMap(([field, messages]) =>
      messages.map((entry) => `${field} : ${entry}`),
    ),
  ];
  return { message, issues };
}

export function NewApplicationForm({ aiEnabled, model }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(aiEnabled ? 'prompt' : 'json');

  const [prompt, setPrompt] = useState('');
  // Indices facultatifs. Ils orientent le modèle sans jamais entrer dans
  // l'AppSpec : `runtime` en particulier est transmis comme contexte de
  // dimensionnement, et le prompt système lui interdit d'apparaître dans la spec.
  const [language, setLanguage] = useState('');
  const [database, setDatabase] = useState('');
  const [runtime, setRuntime] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generationInfo, setGenerationInfo] = useState<string | null>(null);
  const [origin, setOrigin] = useState<GenerationOrigin | null>(null);

  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  function reset() {
    setError(null);
    setIssues([]);
  }

  async function onGenerate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    reset();
    setGenerationInfo(null);
    setGenerating(true);

    const hints: Record<string, string> = {};
    if (language.trim()) hints.language = language.trim();
    if (database.trim()) hints.database = database.trim();
    if (runtime) hints.runtime = runtime;

    try {
      const response = await fetch('/api/applications/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          Object.keys(hints).length > 0 ? { prompt, hints } : { prompt },
        ),
      });

      if (!response.ok) {
        const failure = await readError(response);
        setError(failure.message);
        setIssues(failure.issues);
        return;
      }

      const body = (await response.json()) as {
        appSpec: unknown;
        model: string;
        slugTaken: boolean;
        usage: { totalTokens: number | null };
        durationMs: number;
        attempts: Array<{ index: number; ok: boolean; issues: string[] }>;
      };

      setValue(JSON.stringify(body.appSpec, null, 2));
      setOrigin({ prompt, model: body.model, appSpec: body.appSpec });

      const retried = body.attempts.length > 1;
      setGenerationInfo(
        `${body.model} — ${Math.round(body.durationMs / 100) / 10} s` +
          (body.usage.totalTokens ? `, ${body.usage.totalTokens} tokens` : '') +
          (retried ? ', après une relance sur erreurs de validation' : '') +
          (body.slugTaken ? ' — ⚠ une application porte déjà ce nom' : ''),
      );
    } catch (networkError) {
      setError(
        networkError instanceof Error ? networkError.message : 'Génération impossible',
      );
    } finally {
      setGenerating(false);
    }
  }

  async function onSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    reset();
    setSaving(true);

    let appSpec: unknown;
    try {
      appSpec = JSON.parse(value);
    } catch (parseError) {
      setError(
        `JSON invalide : ${parseError instanceof Error ? parseError.message : 'illisible'}`,
      );
      setSaving(false);
      return;
    }

    const response = await fetch('/api/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // La provenance n'accompagne la création que si la spec vient bien d'une
      // génération : une spec collée à la main n'a pas d'origine à inventer.
      body: JSON.stringify(origin ? { appSpec, generation: origin } : { appSpec }),
    });

    if (!response.ok) {
      const failure = await readError(response);
      setError(failure.message);
      setIssues(failure.issues);
      setSaving(false);
      return;
    }

    setSaving(false);
    router.push('/applications');
    router.refresh();
  }

  const tabs: Array<{ id: Tab; label: string; disabled: boolean }> = [
    { id: 'prompt', label: 'Depuis une description', disabled: !aiEnabled },
    { id: 'json', label: 'Depuis un JSON', disabled: false },
  ];

  return (
    <div className="space-y-6">
      <div role="tablist" className="flex gap-1 border-b">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            disabled={entry.disabled}
            onClick={() => setTab(entry.id)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              tab === entry.id
                ? 'border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground border-transparent',
              entry.disabled && 'cursor-not-allowed opacity-40',
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'prompt' ? (
        <form onSubmit={onGenerate} className="space-y-3">
          {!aiEnabled ? (
            <Alert>
              La génération par IA est désactivée : aucune{' '}
              <code className="font-mono text-xs">OPENROUTER_API_KEY</code> n&apos;est
              configurée sur ce panel. L&apos;onglet « Depuis un JSON » reste disponible.
            </Alert>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="prompt">Décrivez l&apos;application</Label>
            <textarea
              id="prompt"
              name="prompt"
              rows={4}
              value={prompt}
              disabled={!aiEnabled}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Un blog Node avec Postgres et un front nginx"
              className="border-input focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] disabled:opacity-50"
            />
            <p className="text-muted-foreground text-xs">
              Le modèle produit du JSON validé par Zod — jamais une commande. Rien
              n&apos;est enregistré ni déployé : la spec s&apos;affiche ci-dessous, à
              relire et à corriger.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="hint-language">Langage (facultatif)</Label>
              <input
                id="hint-language"
                value={language}
                disabled={!aiEnabled}
                onChange={(event) => setLanguage(event.target.value)}
                placeholder="Node.js"
                className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs disabled:opacity-50"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hint-database">Base de données (facultatif)</Label>
              <input
                id="hint-database"
                value={database}
                disabled={!aiEnabled}
                onChange={(event) => setDatabase(event.target.value)}
                placeholder="PostgreSQL"
                className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs disabled:opacity-50"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hint-runtime">Runtime visé (facultatif)</Label>
              <select
                id="hint-runtime"
                value={runtime}
                disabled={!aiEnabled}
                onChange={(event) => setRuntime(event.target.value)}
                className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs disabled:opacity-50"
              >
                <option value="">indifférent</option>
                <option value="docker">Docker</option>
                <option value="k3s">K3s</option>
              </select>
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            Le runtime n&apos;entre jamais dans l&apos;AppSpec — elle ne connaît ni
            Docker ni Kubernetes. Il ne sert qu&apos;à dimensionner.
          </p>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!aiEnabled || generating || prompt.trim().length < 8}>
              {generating ? 'Génération…' : 'Générer'}
            </Button>
            {generating ? (
              <span
                aria-label="génération en cours"
                className="border-muted-foreground/30 border-t-foreground size-4 animate-spin rounded-full border-2"
              />
            ) : null}
            <Badge variant="outline" className="font-mono">
              {model}
            </Badge>
          </div>

          {generationInfo ? (
            <Alert variant="success" className="text-xs">
              {generationInfo}
            </Alert>
          ) : null}
        </form>
      ) : null}

      {error ? (
        <Alert variant="destructive" className="space-y-1">
          <div>{error}</div>
          {issues.length > 0 ? (
            <ul className="ml-4 list-disc font-mono text-xs">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      <form onSubmit={onSave} className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="appSpec">
              AppSpec (JSON){origin ? ' — générée, éditable' : ''}
            </Label>
            <div className="flex items-center gap-4">
              <AppSpecHelpDialog />
              <button
                type="button"
                onClick={() => {
                  setValue(EXAMPLE);
                  setOrigin(null);
                }}
                className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-4"
              >
                Insérer un exemple
              </button>
            </div>
          </div>
          <textarea
            id="appSpec"
            name="appSpec"
            rows={20}
            spellCheck={false}
            required
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={EXAMPLE}
            className="border-input focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:ring-[3px]"
          />
          {origin ? (
            <p className="text-muted-foreground text-xs">
              Le prompt et la spec générée seront conservés avec l&apos;application, à
              côté de la version que vous validez.
            </p>
          ) : null}
        </div>

        <Button type="submit" disabled={saving || value.trim().length === 0}>
          {saving ? 'Validation…' : "Enregistrer l'application"}
        </Button>
      </form>
    </div>
  );
}
