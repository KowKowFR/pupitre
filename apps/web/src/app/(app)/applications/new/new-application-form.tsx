'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AppSpecHelpDialog } from '@/components/appspec-help';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Rocket, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Tab, Tabs } from '@/components/ui/tabs';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import { common } from '@/i18n/messages/common';
import { applications as messages } from '@/i18n/messages/applications';

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
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="t-h mono">{spec.name}</span>
        <span className="mono t-cap text-text-3">{spec.version}</span>
        <span className="t-sm text-text-3">{t('review.services', { count: spec.services.length })}</span>
      </div>

      <div className="card card-flat overflow-hidden">
        <ul className="list">
          {spec.services.map((service) => {
            const parts = [
              service.port !== null ? t('review.port', { port: service.port }) : null,
              service.replicas !== null && service.replicas > 1 ? `×${service.replicas}` : null,
              service.health ? t('review.health', { value: service.health }) : null,
              service.dependsOn.length > 0 ? t('review.dependsOn', { list: service.dependsOn.join(', ') }) : null,
              service.secrets.length > 0 ? t('review.secrets', { list: service.secrets.join(', ') }) : null,
              service.volumes.length > 0
                ? `${t('review.volumes')} ${service.volumes
                    .map((volume) => `${volume.name} → ${volume.mountPath}${volume.size ? ` (${volume.size})` : ''}`)
                    .join(', ')}`
                : null,
            ].filter(Boolean);
            return (
              <li key={service.name} className="flex-col !items-start gap-0.5 py-2.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="mono text-[12.5px] font-semibold">{service.name}</span>
                  {service.exposed ? <Badge variant="accent">{t('review.exposed')}</Badge> : null}
                  <span className="mono t-cap text-text-3">{service.image}</span>
                </span>
                {parts.length > 0 ? <span className="t-cap text-text-3">{parts.join(' · ')}</span> : null}
                {service.env.length > 0 ? (
                  <span className="mono t-cap text-text-3">
                    {service.env.map(([key, value]) => `${key}=${value}`).join('  ')}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      {spec.ingress ? (
        <span className="t-cap text-text-3">
          {t('review.ingress', {
            host: spec.ingress.host ?? t('review.ingress.noHost'),
            service: spec.ingress.targetService,
            tls: spec.ingress.tls ? ' (TLS)' : '',
          })}
        </span>
      ) : null}

      {thirdParty.length > 0 ? (
        <Alert variant="warn">
          {t('review.thirdParty.lead', { count: thirdParty.length })}{' '}
          <span className="mono">{thirdParty.join(', ')}</span>
          {t('review.thirdParty.tail')}
        </Alert>
      ) : null}

      {floating.length > 0 ? (
        <Alert variant="warn">
          {t('review.floating.lead')}
          <span className="mono">{floating.join(', ')}</span>
          {t('review.floating.tail')}
        </Alert>
      ) : null}

      {secrets.length > 0 ? (
        <Alert variant="info">
          {t('review.declaredSecrets.lead', { count: secrets.length })}{' '}
          <span className="mono">{secrets.join(', ')}</span>
          {t('review.declaredSecrets.mid')} <strong>{t('review.declaredSecrets.names')}</strong>
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
  const tChrome = useT(chrome);
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

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('new.card.title')}</CardTitle>
            <CardDescription>{t('new.left.sub')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Tabs label={t('new.card.title')}>
              <Tab selected={tab === 'prompt'} disabled={!aiEnabled} onClick={() => setTab('prompt')}>
                {t('tab.fromPrompt')}
              </Tab>
              <Tab selected={tab === 'json'} onClick={() => setTab('json')}>
                {t('tab.fromJson')}
              </Tab>
            </Tabs>

            {tab === 'prompt' ? (
              <form onSubmit={onGenerate} className="flex flex-col gap-4">
                {!aiEnabled ? (
                  <Alert>
                    {t('ai.disabled.lead', { provider })}
                    {missingKeyVar ? (
                      <>
                        {' '}
                        {t('ai.disabled.envVar')} <code className="code">{missingKeyVar}</code>)
                      </>
                    ) : null}
                    {t('ai.disabled.tail')}
                  </Alert>
                ) : null}

                {aiEnabled && modelWarning ? <Alert variant="destructive">{modelWarning}</Alert> : null}

                <Field label={t('form.prompt.label')} help={t('form.prompt.help')}>
                  <Textarea
                    name="prompt"
                    rows={3}
                    value={prompt}
                    disabled={!aiEnabled}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder={t('form.prompt.placeholder')}
                  />
                </Field>

                <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  <Field label={t('form.hint.language')} optional>
                    <Input
                      value={language}
                      disabled={!aiEnabled}
                      onChange={(event) => setLanguage(event.target.value)}
                      placeholder="Node.js"
                    />
                  </Field>
                  <Field label={t('form.hint.database')} optional>
                    <Input
                      value={database}
                      disabled={!aiEnabled}
                      onChange={(event) => setDatabase(event.target.value)}
                      placeholder="PostgreSQL"
                    />
                  </Field>
                  <Field label={t('form.hint.runtime')} optional>
                    <Select
                      value={runtimeHint}
                      disabled={!aiEnabled}
                      onChange={(event) => setRuntimeHint(event.target.value)}
                    >
                      <option value="">{t('form.hint.runtime.any')}</option>
                      <option value="docker">Docker</option>
                      <option value="k3s">K3s</option>
                    </Select>
                  </Field>
                  <Button
                    type="submit"
                    variant={origin ? 'secondary' : 'default'}
                    loading={generating}
                    disabled={!aiEnabled || prompt.trim().length < 8}
                  >
                    {generating ? null : <Sparkles aria-hidden />}
                    {generating ? t('generate.pending') : origin ? t('generate.again') : t('generate.action')}
                  </Button>
                </div>
                <p className="help">
                  {t('form.hint.note')}{' '}
                  <span className="mono">
                    {provider} · {model}
                  </span>
                </p>

                {generationInfo ? (
                  <Alert variant="success" title={t('generate.done')}>
                    <span className="mono text-[12px]">{generationInfo}</span>
                  </Alert>
                ) : null}
              </form>
            ) : (
              <div className="flex flex-col items-start gap-3">
                <p className="t-sm text-text-2">{t('new.json.tab.hint')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <AppSpecHelpDialog />
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setValue(EXAMPLE);
                      setOrigin(null);
                    }}
                  >
                    {t('form.insertExample')}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <form onSubmit={onSave}>
          <Card>
            <CardHeader>
              <CardTitle>{t('new.deploy.title')}</CardTitle>
              <CardDescription>{tChrome('field.optional')}</CardDescription>
            </CardHeader>
            {targets.length > 0 ? (
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t('drawer.deploy.target')}>
                  <Select
                    value={targetId}
                    onChange={(event) => {
                      const next = event.target.value;
                      setTargetId(next);
                      const target = targets.find((candidate) => candidate.id === next);
                      const first = target?.runtimes[0];
                      if (first) setDeployRuntime(first);
                    }}
                  >
                    <option value="">{t('form.deployTarget.none')}</option>
                    {targets.map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.name} ({target.host})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('form.runtime.label')} help={t('drawer.deploy.runtime.help')}>
                  <Select
                    value={deployRuntime}
                    disabled={!selectedTarget}
                    onChange={(event) => setDeployRuntime(event.target.value === 'k3s' ? 'k3s' : 'docker')}
                  >
                    {(selectedTarget?.runtimes ?? ['docker' as const]).map((entry) => (
                      <option key={entry} value={entry}>
                        {t(`runtime.${entry}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </CardContent>
            ) : null}
            <CardFooter className="flex-wrap">
              <span className="t-cap text-text-3">
                {selectedTarget ? t('new.deploy.note') : t('new.deploy.noteSave')}
              </span>
              <span className="ml-auto flex items-center gap-2">
                <Button variant="ghost" type="button" onClick={() => router.back()}>
                  {tc('cancel')}
                </Button>
                <Button type="submit" loading={saving} disabled={value.trim().length === 0}>
                  {saving ? null : selectedTarget ? <Rocket aria-hidden /> : null}
                  {saving
                    ? t('form.submit.pending')
                    : selectedTarget
                      ? t('form.submit.saveAndDeploy')
                      : t('form.submit.save')}
                </Button>
              </span>
            </CardFooter>
          </Card>
        </form>
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        {error ? (
          <Alert variant="destructive">
            <div>{error}</div>
            {issues.length > 0 ? (
              <ul className="bul mono mt-1 flex flex-col gap-0.5 text-[12px]">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : null}
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>{t('review.label')}</CardTitle>
            <CardDescription>
              {origin ? t('new.review.sub.proposal') : t('new.review.sub.manual')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {review ? <SpecReview spec={review} /> : <p className="t-sm text-text-3">{t('new.review.empty')}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            actions={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setValue(EXAMPLE);
                  setOrigin(null);
                }}
              >
                {t('form.insertExample')}
              </Button>
            }
          >
            <CardTitle>{t('form.appSpec.label')}</CardTitle>
            <CardDescription>
              {origin ? t('new.json.sub.generated') : t('new.json.sub.manual')}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Textarea
              id="appSpec"
              name="appSpec"
              rows={18}
              wrap="off"
              spellCheck={false}
              aria-label={t('form.appSpec.label')}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={EXAMPLE}
              className="mono bg-surface-2"
            />
            {origin ? <p className="help">{t('form.origin.note')}</p> : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
