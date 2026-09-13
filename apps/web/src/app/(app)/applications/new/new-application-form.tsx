'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AppSpecHelpDialog } from '@/components/appspec-help';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { applications as messages } from '@/i18n/messages/applications';
import { cn } from '@/lib/utils';

/**
 * Création d'une application, par deux chemins qui aboutissent au même endroit.
 *
 * L'onglet « Depuis une description » ne fait qu'*alimenter* la revue et
 * l'éditeur JSON : la génération ne crée rien, ne déploie rien. C'est le même
 * bouton « Enregistrer » qui valide dans les deux cas, et la même route
 * `POST /api/applications`. L'IA propose ; l'opérateur dispose.
 *
 * Le parcours complet — décrire, générer, **revoir**, créer, déployer — tient
 * sur cet écran, mais chaque étape reste un appel distinct à une route
 * existante. Rien n'enchaîne la génération au déploiement sans que la spec ait
 * été affichée : c'est précisément ce que la règle 4 protège.
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

type DeployTarget = {
  id: string;
  name: string;
  host: string;
  runtimes: Array<'docker' | 'k3s'>;
};

type Tab = 'prompt' | 'json';

type Props = {
  /** `false` quand aucune clé n'est configurée, ou que l'IA est coupée. */
  aiEnabled: boolean;
  /** Libellé du fournisseur retenu — « OpenRouter », « OpenAI », « Anthropic ». */
  provider: string;
  model: string;
  /** Non nul quand le modèle ne ressemble pas à un identifiant du fournisseur. */
  modelWarning: string | null;
  /** Variable d'environnement de repli du fournisseur, à citer quand la clé manque. */
  missingKeyVar: string | null;
  /** Cibles déployables. Vide si l'utilisateur n'a pas `deployment:create`. */
  targets: DeployTarget[];
};

async function readError(
  response: Response,
  words: { fallback: string; fieldError: (field: string, message: string) => string },
): Promise<{ message: string; issues: string[] }> {
  const body = (await response.json().catch(() => ({}))) as ApiError;
  const message = body.error?.message ?? words.fallback;

  // Deux formes d'erreur, une seule présentation : les reproches de Zod champ
  // par champ (création), et ceux de la validation d'AppSpec (génération).
  const fieldErrors = body.error?.details?.fieldErrors ?? {};
  const issues = [
    ...(body.error?.details?.issues ?? []),
    ...Object.entries(fieldErrors).flatMap(([field, entries]) =>
      entries.map((entry) => words.fieldError(field, entry)),
    ),
  ];
  return { message, issues };
}

// ─── Lecture de la spec pour la revue ────────────────────────────────────────

/**
 * Relecture permissive du JSON de l'éditeur, pour l'afficher.
 *
 * Volontairement séparée de la validation : ici on *montre* ce qui est écrit, y
 * compris pendant une retouche à moitié faite. La seule autorité reste
 * `appSpecSchema`, côté serveur, au moment de l'enregistrement — cette lecture
 * ne valide rien et ne doit jamais donner l'impression de le faire.
 */
type ReviewVolume = { name: string; mountPath: string; size: string | null };
type ReviewService = {
  name: string;
  image: string;
  port: number | null;
  exposed: boolean;
  replicas: number | null;
  env: Array<[string, string]>;
  secrets: string[];
  volumes: ReviewVolume[];
  health: string | null;
  dependsOn: string[];
};
type ReviewSpec = {
  name: string;
  version: string;
  services: ReviewService[];
  ingress: { host: string | null; tls: boolean; targetService: string } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Les mots dont la relecture a besoin. Passés en argument plutôt que lus par un
 * hook : ces fonctions sont pures, appelées hors composant, et le resteront.
 */
type ReviewWords = {
  none: string;
  unnamed: string;
  healthPort: (port: number) => string;
  healthGet: (path: string) => string;
  healthInterval: (seconds: number) => string;
  healthRetries: (retries: number) => string;
};

function describeSource(source: unknown, words: ReviewWords): string {
  if (!isRecord(source)) return words.none;
  if (source.type === 'image') return str(source.ref, words.none);
  if (source.type === 'dockerfile') {
    return `build ${str(source.context, '.')}/${str(source.dockerfile, 'Dockerfile')}`;
  }
  return words.none;
}

function describeHealth(health: unknown, words: ReviewWords): string | null {
  if (!isRecord(health)) return null;
  const port = num(health.port);
  const path = str(health.path, '/');
  const interval = num(health.intervalSec);
  const retries = num(health.retries);
  const probe = port !== null ? words.healthPort(port) : words.healthGet(path);
  return `${probe}${interval !== null ? words.healthInterval(interval) : ''}${
    retries !== null ? words.healthRetries(retries) : ''
  }`;
}

/**
 * Un secret, tel qu'il se relit avant déploiement.
 *
 * Un nom peut reprendre la valeur d'un autre (`{ name, from }`) : la relecture
 * doit le montrer, sinon deux noms partageant un seul mot de passe se lisent
 * comme deux secrets indépendants — exactement le malentendu que `from` corrige.
 */
function describeSecret(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (isRecord(entry) && typeof entry.name === 'string') {
    return typeof entry.from === 'string' ? `${entry.name} ← ${entry.from}` : entry.name;
  }
  return '';
}

function parseReview(text: string, words: ReviewWords): ReviewSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  const services = arr(raw.services)
    .filter(isRecord)
    .map<ReviewService>((service) => ({
      name: str(service.name, words.unnamed),
      image: describeSource(service.source, words),
      port: num(service.port),
      exposed: service.exposed === true,
      replicas: num(service.replicas),
      env: isRecord(service.env)
        ? Object.entries(service.env).map(([key, value]) => [key, str(value)])
        : [],
      secrets: arr(service.secrets).map(describeSecret).filter((entry) => entry !== ''),
      volumes: arr(service.volumes)
        .filter(isRecord)
        .map((volume) => ({
          name: str(volume.name, words.unnamed),
          mountPath: str(volume.mountPath, words.none),
          size: typeof volume.size === 'string' ? volume.size : null,
        })),
      health: describeHealth(service.healthcheck, words),
      dependsOn: arr(service.dependsOn).map((entry) => str(entry)).filter((e) => e !== ''),
    }));

  const ingress = isRecord(raw.ingress)
    ? {
        host: typeof raw.ingress.host === 'string' ? raw.ingress.host : null,
        tls: raw.ingress.tls === true,
        targetService: str(raw.ingress.targetService, words.none),
      }
    : null;

  return {
    name: str(raw.name, words.unnamed),
    version: str(raw.version, words.none),
    services,
    ingress,
  };
}

/**
 * Images publiées par un tiers — tout ce qui n'est pas la bibliothèque
 * officielle de Docker Hub. Le panel ne peut pas vérifier qu'un tag existe sans
 * contacter le registre depuis la machine cible, ce qui n'arrive qu'au
 * déploiement. Un modèle qui invente un `10.0.14` plausible fait donc échouer la
 * mise en ligne plusieurs minutes plus tard, au `pull`. Le dire à la relecture
 * coûte une ligne et fait gagner ce détour.
 */
function thirdPartyImage(image: string): boolean {
  if (!image.includes(':') || image.startsWith('build ')) return false;
  const [repository] = image.split(':');
  if (!repository) return false;
  const path = repository.replace(/^docker\.io\//, '');
  return path.includes('/') && !path.startsWith('library/');
}

/** Tag flottant : ce qui tourne aujourd'hui ne sera pas ce qui tournera demain. */
function floatingTag(image: string): boolean {
  return /:(latest|stable|main|edge)$/.test(image);
}

function SpecReview({ spec }: { spec: ReviewSpec }) {
  const t = useT(messages);
  const secrets = [...new Set(spec.services.flatMap((service) => service.secrets))];
  const images = spec.services.map((service) => service.image);
  const thirdParty = images.filter((image) => thirdPartyImage(image));
  const floating = images.filter((image) => floatingTag(image));

  return (
    <div className="space-y-3 rounded-md border p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-medium">{spec.name}</span>
        <Badge variant="outline" className="font-mono">
          {spec.version}
        </Badge>
        <span className="text-muted-foreground text-xs">
          {t('review.services', { count: spec.services.length })}
        </span>
      </div>

      <ul className="space-y-3">
        {spec.services.map((service) => (
          <li key={service.name} className="space-y-1 border-l-2 pl-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-medium">{service.name}</span>
              {service.exposed ? <Badge variant="ok">{t('review.exposed')}</Badge> : null}
              {service.port !== null ? (
                <span className="text-muted-foreground text-xs">
                  {t('review.port', { port: service.port })}
                </span>
              ) : null}
              {service.replicas !== null && service.replicas > 1 ? (
                <span className="text-muted-foreground text-xs">×{service.replicas}</span>
              ) : null}
            </div>
            <div className="text-muted-foreground font-mono text-xs">{service.image}</div>
            {service.health ? (
              <div className="text-muted-foreground text-xs">
                {t('review.health', { value: service.health })}
              </div>
            ) : null}
            {service.dependsOn.length > 0 ? (
              <div className="text-muted-foreground text-xs">
                {t('review.dependsOn', { list: service.dependsOn.join(', ') })}
              </div>
            ) : null}
            {service.env.length > 0 ? (
              <div className="text-muted-foreground font-mono text-xs">
                {service.env.map(([key, value]) => `${key}=${value}`).join('  ')}
              </div>
            ) : null}
            {service.secrets.length > 0 ? (
              <div className="text-muted-foreground font-mono text-xs">
                {t('review.secrets', { list: service.secrets.join(', ') })}
              </div>
            ) : null}
            {service.volumes.length > 0 ? (
              <div className="text-muted-foreground text-xs">
                {t('review.volumes')}{' '}
                {service.volumes
                  .map(
                    (volume) =>
                      `${volume.name} → ${volume.mountPath}${volume.size ? ` (${volume.size})` : ''}`,
                  )
                  .join(', ')}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {spec.ingress ? (
        <div className="text-muted-foreground text-xs">
          {t('review.ingress', {
            host: spec.ingress.host ?? t('review.ingress.noHost'),
            service: spec.ingress.targetService,
            tls: spec.ingress.tls ? ' (TLS)' : '',
          })}
        </div>
      ) : null}

      {thirdParty.length > 0 ? (
        <Alert className="text-xs">
          {t('review.thirdParty.lead', { count: thirdParty.length })}{' '}
          <span className="font-mono">{thirdParty.join(', ')}</span>
          {t('review.thirdParty.tail')}
        </Alert>
      ) : null}

      {floating.length > 0 ? (
        <Alert className="text-xs">
          {t('review.floating.lead')}
          <span className="font-mono">{floating.join(', ')}</span>
          {t('review.floating.tail')}
        </Alert>
      ) : null}

      {secrets.length > 0 ? (
        <Alert className="text-xs">
          {t('review.declaredSecrets.lead', { count: secrets.length })}{' '}
          <span className="font-mono">{secrets.join(', ')}</span>
          {t('review.declaredSecrets.mid')}{' '}
          <strong>{t('review.declaredSecrets.names')}</strong>
          {t('review.declaredSecrets.tail')}
        </Alert>
      ) : null}
    </div>
  );
}

// ─── Formulaire ──────────────────────────────────────────────────────────────

export function NewApplicationForm({
  aiEnabled,
  provider,
  model,
  modelWarning,
  missingKeyVar,
  targets,
}: Props) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(aiEnabled ? 'prompt' : 'json');

  const [prompt, setPrompt] = useState('');
  // Indices facultatifs. Ils orientent le modèle sans jamais entrer dans
  // l'AppSpec : `runtime` en particulier est transmis comme contexte de
  // dimensionnement, et le prompt système lui interdit d'apparaître dans la spec.
  const [language, setLanguage] = useState('');
  const [database, setDatabase] = useState('');
  const [runtimeHint, setRuntimeHint] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generationInfo, setGenerationInfo] = useState<string | null>(null);
  const [origin, setOrigin] = useState<GenerationOrigin | null>(null);

  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  // Déploiement facultatif, dans la foulée de la création. Vide = on s'arrête à
  // l'enregistrement.
  const [targetId, setTargetId] = useState('');
  const selectedTarget = targets.find((target) => target.id === targetId) ?? null;
  const [deployRuntime, setDeployRuntime] = useState<'docker' | 'k3s'>('docker');

  const words: ReviewWords = {
    none: tc('none'),
    unnamed: t('review.unnamed'),
    healthPort: (port) => t('review.health.port', { port }),
    healthGet: (path) => t('review.health.get', { path }),
    healthInterval: (seconds) => t('review.health.interval', { seconds }),
    healthRetries: (retries) => t('review.health.retries', { retries }),
  };
  /** `readError` est pure : elle reçoit ses mots, elle ne va pas les chercher. */
  const failureOf = (response: Response) =>
    readError(response, {
      fallback: tc('http.failure', { status: response.status }),
      fieldError: (field, message) => t('form.fieldError', { field, message }),
    });

  const review = parseReview(value, words);

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
    if (runtimeHint) hints.runtime = runtimeHint;

    try {
      const response = await fetch('/api/applications/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          Object.keys(hints).length > 0 ? { prompt, hints } : { prompt },
        ),
      });

      if (!response.ok) {
        const failure = await failureOf(response);
        setError(failure.message);
        setIssues(failure.issues);
        return;
      }

      const body = (await response.json()) as {
        appSpec: unknown;
        model: string;
        providerLabel: string;
        slugTaken: boolean;
        usage: { totalTokens: number | null };
        durationMs: number;
        attempts: Array<{ index: number; ok: boolean; issues: string[] }>;
      };

      setValue(JSON.stringify(body.appSpec, null, 2));
      setOrigin({ prompt, model: body.model, appSpec: body.appSpec });

      const retried = body.attempts.length > 1;
      setGenerationInfo(
        t('generate.info', {
          provider: body.providerLabel,
          model: body.model,
          seconds: Math.round(body.durationMs / 100) / 10,
        }) +
          (body.usage.totalTokens
            ? t('generate.info.tokens', { tokens: body.usage.totalTokens })
            : '') +
          (retried ? t('generate.info.retried') : '') +
          (body.slugTaken ? t('generate.info.slugTaken') : ''),
      );
    } catch (networkError) {
      setError(networkError instanceof Error ? networkError.message : t('generate.failed'));
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
        t('form.invalidJson', {
          message: parseError instanceof Error ? parseError.message : t('form.unreadable'),
        }),
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
      const failure = await failureOf(response);
      setError(failure.message);
      setIssues(failure.issues);
      setSaving(false);
      return;
    }

    const application = (await response.json()) as { id: string };

    if (selectedTarget) {
      // Deuxième appel, route existante. `scanConfig` est volontairement absent :
      // sans demande explicite, c'est la politique de sécurité de l'instance qui
      // s'applique — et la choisir ici exigerait `scan:configure`.
      const deployment = await fetch('/api/deployments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          applicationId: application.id,
          targetId: selectedTarget.id,
          runtime: deployRuntime,
          proxy: 'traefik',
          autoRollback: true,
        }),
      });

      if (!deployment.ok) {
        const failure = await failureOf(deployment);
        setError(
          t('form.savedButDeployFailed', {
            name: review?.name ?? '',
            message: failure.message,
          }),
        );
        setIssues(failure.issues);
        setSaving(false);
        router.refresh();
        return;
      }

      const { id } = (await deployment.json()) as { id: string };
      setSaving(false);
      router.push(`/deployments/${id}`);
      return;
    }

    setSaving(false);
    router.push('/applications');
    router.refresh();
  }

  const tabs: Array<{ id: Tab; label: string; disabled: boolean }> = [
    { id: 'prompt', label: t('tab.fromPrompt'), disabled: !aiEnabled },
    { id: 'json', label: t('tab.fromJson'), disabled: false },
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
              {t('ai.disabled.lead', { provider })}
              {missingKeyVar ? (
                <>
                  {' '}
                  {t('ai.disabled.envVar')}{' '}
                  <code className="font-mono text-xs">{missingKeyVar}</code>)
                </>
              ) : null}
              {t('ai.disabled.tail')}
            </Alert>
          ) : null}

          {aiEnabled && modelWarning ? <Alert variant="destructive">{modelWarning}</Alert> : null}

          <div className="space-y-1.5">
            <Label htmlFor="prompt">{t('form.prompt.label')}</Label>
            <textarea
              id="prompt"
              name="prompt"
              rows={4}
              value={prompt}
              disabled={!aiEnabled}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={t('form.prompt.placeholder')}
              className="border-input focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] disabled:opacity-50"
            />
            <p className="text-muted-foreground text-xs">{t('form.prompt.help')}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="hint-language">{t('form.hint.language')}</Label>
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
              <Label htmlFor="hint-database">{t('form.hint.database')}</Label>
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
              <Label htmlFor="hint-runtime">{t('form.hint.runtime')}</Label>
              <select
                id="hint-runtime"
                value={runtimeHint}
                disabled={!aiEnabled}
                onChange={(event) => setRuntimeHint(event.target.value)}
                className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs disabled:opacity-50"
              >
                <option value="">{t('form.hint.runtime.any')}</option>
                <option value="docker">Docker</option>
                <option value="k3s">K3s</option>
              </select>
            </div>
          </div>
          <p className="text-muted-foreground text-xs">{t('form.hint.note')}</p>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!aiEnabled || generating || prompt.trim().length < 8}>
              {generating ? t('generate.pending') : t('generate.action')}
            </Button>
            {generating ? (
              <span
                aria-label={t('generate.busy')}
                className="border-muted-foreground/30 border-t-foreground size-4 animate-spin rounded-full border-2"
              />
            ) : null}
            <Badge variant="outline">{provider}</Badge>
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
        {review ? (
          <div className="space-y-1.5">
            <Label>
              {t('review.label')}
              {origin ? t('review.label.proposal') : ''}
            </Label>
            <SpecReview spec={review} />
          </div>
        ) : null}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="appSpec">
              {t('form.appSpec.label')}
              {origin ? t('form.appSpec.label.generated') : ''}
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
                {t('form.insertExample')}
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
            <p className="text-muted-foreground text-xs">{t('form.origin.note')}</p>
          ) : null}
        </div>

        {targets.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="deploy-target">{t('form.deployTarget.label')}</Label>
              <select
                id="deploy-target"
                value={targetId}
                onChange={(event) => {
                  const next = event.target.value;
                  setTargetId(next);
                  const target = targets.find((candidate) => candidate.id === next);
                  const first = target?.runtimes[0];
                  if (first) setDeployRuntime(first);
                }}
                className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs"
              >
                <option value="">{t('form.deployTarget.none')}</option>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name} ({target.host})
                  </option>
                ))}
              </select>
            </div>
            {selectedTarget ? (
              <div className="space-y-1.5">
                <Label htmlFor="deploy-runtime">{t('form.runtime.label')}</Label>
                <select
                  id="deploy-runtime"
                  value={deployRuntime}
                  onChange={(event) =>
                    setDeployRuntime(event.target.value === 'k3s' ? 'k3s' : 'docker')
                  }
                  className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs"
                >
                  {selectedTarget.runtimes.map((entry) => (
                    <option key={entry} value={entry}>
                      {entry === 'docker' ? 'Docker Compose' : 'K3s'}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
        ) : null}

        <Button type="submit" disabled={saving || value.trim().length === 0}>
          {saving
            ? t('form.submit.pending')
            : selectedTarget
              ? t('form.submit.saveAndDeploy')
              : t('form.submit.save')}
        </Button>
      </form>
    </div>
  );
}
