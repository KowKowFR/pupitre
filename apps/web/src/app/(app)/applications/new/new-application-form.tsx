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

function describeSource(source: unknown): string {
  if (!isRecord(source)) return '—';
  if (source.type === 'image') return str(source.ref, '—');
  if (source.type === 'dockerfile') {
    return `build ${str(source.context, '.')}/${str(source.dockerfile, 'Dockerfile')}`;
  }
  return '—';
}

function describeHealth(health: unknown): string | null {
  if (!isRecord(health)) return null;
  const port = num(health.port);
  const path = str(health.path, '/');
  const interval = num(health.intervalSec);
  const retries = num(health.retries);
  const probe = port !== null ? `port ${port}` : `GET ${path}`;
  return `${probe}${interval !== null ? `, toutes les ${interval} s` : ''}${
    retries !== null ? `, ${retries} essais` : ''
  }`;
}

function parseReview(text: string): ReviewSpec | null {
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
      name: str(service.name, '(sans nom)'),
      image: describeSource(service.source),
      port: num(service.port),
      exposed: service.exposed === true,
      replicas: num(service.replicas),
      env: isRecord(service.env)
        ? Object.entries(service.env).map(([key, value]) => [key, str(value)])
        : [],
      secrets: arr(service.secrets).map((entry) => str(entry)).filter((entry) => entry !== ''),
      volumes: arr(service.volumes)
        .filter(isRecord)
        .map((volume) => ({
          name: str(volume.name, '(sans nom)'),
          mountPath: str(volume.mountPath, '—'),
          size: typeof volume.size === 'string' ? volume.size : null,
        })),
      health: describeHealth(service.healthcheck),
      dependsOn: arr(service.dependsOn).map((entry) => str(entry)).filter((e) => e !== ''),
    }));

  const ingress = isRecord(raw.ingress)
    ? {
        host: typeof raw.ingress.host === 'string' ? raw.ingress.host : null,
        tls: raw.ingress.tls === true,
        targetService: str(raw.ingress.targetService, '—'),
      }
    : null;

  return {
    name: str(raw.name, '(sans nom)'),
    version: str(raw.version, '—'),
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
          {spec.services.length} service{spec.services.length > 1 ? 's' : ''}
        </span>
      </div>

      <ul className="space-y-3">
        {spec.services.map((service) => (
          <li key={service.name} className="space-y-1 border-l-2 pl-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-medium">{service.name}</span>
              {service.exposed ? <Badge variant="ok">exposé</Badge> : null}
              {service.port !== null ? (
                <span className="text-muted-foreground text-xs">port {service.port}</span>
              ) : null}
              {service.replicas !== null && service.replicas > 1 ? (
                <span className="text-muted-foreground text-xs">×{service.replicas}</span>
              ) : null}
            </div>
            <div className="text-muted-foreground font-mono text-xs">{service.image}</div>
            {service.health ? (
              <div className="text-muted-foreground text-xs">santé : {service.health}</div>
            ) : null}
            {service.dependsOn.length > 0 ? (
              <div className="text-muted-foreground text-xs">
                dépend de : {service.dependsOn.join(', ')}
              </div>
            ) : null}
            {service.env.length > 0 ? (
              <div className="text-muted-foreground font-mono text-xs">
                {service.env.map(([key, value]) => `${key}=${value}`).join('  ')}
              </div>
            ) : null}
            {service.secrets.length > 0 ? (
              <div className="text-muted-foreground font-mono text-xs">
                secrets : {service.secrets.join(', ')}
              </div>
            ) : null}
            {service.volumes.length > 0 ? (
              <div className="text-muted-foreground text-xs">
                volumes :{' '}
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
          ingress : {spec.ingress.host ?? 'sans nom de domaine'} → {spec.ingress.targetService}
          {spec.ingress.tls ? ' (TLS)' : ''}
        </div>
      ) : null}

      {thirdParty.length > 0 ? (
        <Alert className="text-xs">
          Image{thirdParty.length > 1 ? 's' : ''} publiée
          {thirdParty.length > 1 ? 's' : ''} par un tiers :{' '}
          <span className="font-mono">{thirdParty.join(', ')}</span>. Le panel ne vérifie pas
          qu&apos;un tag existe avant le déploiement — un tag inexistant fait échouer la mise en
          ligne au téléchargement de l&apos;image. Vérifiez-le sur le registre avant de
          déployer.
        </Alert>
      ) : null}

      {floating.length > 0 ? (
        <Alert className="text-xs">
          Tag flottant : <span className="font-mono">{floating.join(', ')}</span>. Un
          redéploiement ne redonnera pas forcément la même version. Figez-le si le projet
          publie un tag de version.
        </Alert>
      ) : null}

      {secrets.length > 0 ? (
        <Alert className="text-xs">
          Cette spec déclare {secrets.length} secret{secrets.length > 1 ? 's' : ''} —{' '}
          <span className="font-mono">{secrets.join(', ')}</span>. Seuls leurs{' '}
          <strong>noms</strong> sont enregistrés : le panel ne stocke pas encore leurs valeurs, et
          les déploiera vides. Les services qui en dépendent (une base de données, par exemple)
          ne démarreront pas tant que ces valeurs ne seront pas fournies sur la cible.
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

  const review = parseReview(value);

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
        const failure = await readError(response);
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
        `${body.providerLabel} · ${body.model} — ${Math.round(body.durationMs / 100) / 10} s` +
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
        const failure = await readError(deployment);
        setError(
          `L'application « ${review?.name ?? ''} » a bien été enregistrée, mais le ` +
            `déploiement a échoué : ${failure.message}`,
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
              La génération par IA est désactivée : aucune clé d&apos;API {provider} n&apos;est
              configurée sur ce panel
              {missingKeyVar ? (
                <>
                  {' '}
                  (ni dans Paramètres → Intelligence artificielle, ni via{' '}
                  <code className="font-mono text-xs">{missingKeyVar}</code>)
                </>
              ) : null}
              . L&apos;onglet « Depuis un JSON » reste disponible.
            </Alert>
          ) : null}

          {aiEnabled && modelWarning ? <Alert variant="destructive">{modelWarning}</Alert> : null}

          <div className="space-y-1.5">
            <Label htmlFor="prompt">Décrivez l&apos;application</Label>
            <textarea
              id="prompt"
              name="prompt"
              rows={4}
              value={prompt}
              disabled={!aiEnabled}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Génère une application GLPI avec sa base de données"
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
                value={runtimeHint}
                disabled={!aiEnabled}
                onChange={(event) => setRuntimeHint(event.target.value)}
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
              Ce qui va tourner{origin ? ' — proposition du modèle, à valider' : ''}
            </Label>
            <SpecReview spec={review} />
          </div>
        ) : null}

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

        {targets.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="deploy-target">Déployer dans la foulée (facultatif)</Label>
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
                <option value="">ne pas déployer maintenant</option>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name} ({target.host})
                  </option>
                ))}
              </select>
            </div>
            {selectedTarget ? (
              <div className="space-y-1.5">
                <Label htmlFor="deploy-runtime">Runtime</Label>
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
            ? 'Validation…'
            : selectedTarget
              ? "Enregistrer et déployer l'application"
              : "Enregistrer l'application"}
        </Button>
      </form>
    </div>
  );
}
