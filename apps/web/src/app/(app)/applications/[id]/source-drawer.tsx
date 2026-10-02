'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowUpRight, GitBranch } from 'lucide-react';
import type { SourceRepository } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import {
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerSection,
} from '@/components/ui/drawer';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SwitchField } from '@/components/ui/switch';
import { useT } from '@/i18n/client';
import { applications as appMessages } from '@/i18n/messages/applications';
import { common } from '@/i18n/messages/common';
import { sources as messages } from '@/i18n/messages/sources';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { SourceMode, SourceView } from './application-sources';

type ApiError = { error?: { message?: string } };
type Runtime = 'docker' | 'k3s';

/** Une cible dont le preflight a vu au moins un runtime exploitable. */
export type DeployTarget = { id: string; name: string; runtimes: Runtime[] };

const MODES: readonly SourceMode[] = ['auto_unless_infra', 'auto', 'manual'];

type DeployTo = SourceView['deployTo'];
const DEPLOY_TO: readonly DeployTo[] = ['none', 'running', 'targets'];

/**
 * Relier un dépôt, ou modifier une liaison, dans un tiroir au-dessus de la
 * fiche.
 *
 * Le partage des rôles se lit dans l'ordre des champs : le dépôt et son
 * `pupitre.json` disent **quoi** déployer ; le tiroir dit **où** (les cibles,
 * et leur runtime) et **quand** (le mode). Le dépôt ne choisit jamais sa
 * cible — c'est ce qui permet de lui faire confiance.
 */
export function SourceDrawer({
  open,
  onClose,
  applicationId,
  source,
  targets,
  installUrl,
}: {
  open: boolean;
  onClose: () => void;
  applicationId: string;
  /** `null` : une nouvelle liaison. */
  source: SourceView | null;
  targets: DeployTarget[];
  installUrl: string;
}) {
  const t = useT(messages);
  const title = source ? t('drawer.title.edit') : t('drawer.title.new');
  return (
    <Drawer open={open} onOpenChange={(next) => (next ? undefined : onClose())} label={title}>
      {open ? (
        <>
          <DrawerHeader
            icon={<GitBranch />}
            kind={t('drawer.kind')}
            route={source ? `${source.repository}@${source.branch}` : undefined}
            title={title}
            extra={<p className="t-sm text-text-2">{t('drawer.lead')}</p>}
          />
          <SourceForm
            key={source?.id ?? 'new'}
            applicationId={applicationId}
            source={source}
            targets={targets}
            installUrl={installUrl}
            onDone={onClose}
          />
        </>
      ) : null}
    </Drawer>
  );
}

function SourceForm({
  applicationId,
  source,
  targets,
  installUrl,
  onDone,
}: {
  applicationId: string;
  source: SourceView | null;
  targets: DeployTarget[];
  installUrl: string;
  onDone: () => void;
}) {
  const t = useT(messages);
  const ta = useT(appMessages);
  const tc = useT(common);
  const router = useRouter();

  const [repositories, setRepositories] = useState<SourceRepository[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [repoKey, setRepoKey] = useState('');
  const [branch, setBranch] = useState(source?.branch ?? '');
  const [branchTouched, setBranchTouched] = useState(source !== null);
  const [specPath, setSpecPath] = useState(source?.specPath ?? 'pupitre.json');
  const [watchText, setWatchText] = useState(source?.watchPaths.join('\n') ?? '');
  const [chosen, setChosen] = useState<Record<string, Runtime>>(() =>
    Object.fromEntries((source?.targets ?? []).map((target) => [target.targetId, target.runtime])),
  );
  const [mode, setMode] = useState<SourceMode>(source?.mode ?? 'auto_unless_infra');
  const [deployTo, setDeployTo] = useState<DeployTo>(source?.deployTo ?? 'none');
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Le dépôt d'une liaison ne change pas : la liste n'est utile qu'à la création.
  useEffect(() => {
    if (source) return;
    let cancelled = false;
    void (async () => {
      const response = await fetch('/api/integrations/github/repositories');
      if (cancelled) return;
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ApiError;
        setLoadError(body.error?.message ?? tc('http.failure', { status: response.status }));
        setRepositories([]);
        return;
      }
      const body = (await response.json()) as { items: SourceRepository[] };
      if (!cancelled) setRepositories(body.items);
    })();
    return () => {
      cancelled = true;
    };
  }, [source, tc]);

  // Une cible liée qui n'est plus prête reste visible : la décocher est un
  // choix, pas un oubli silencieux.
  const offered: DeployTarget[] = [
    ...targets,
    ...(source?.targets ?? [])
      .filter((linked) => !targets.some((target) => target.id === linked.targetId))
      .map((linked) => ({
        id: linked.targetId,
        name: linked.targetName,
        runtimes: [linked.runtime],
      })),
  ];

  const keyOf = (repo: SourceRepository) => `${repo.installationId}:${repo.fullName}`;
  const repository = repositories?.find((repo) => keyOf(repo) === repoKey) ?? null;

  function pickRepository(key: string) {
    setRepoKey(key);
    const picked = repositories?.find((repo) => keyOf(repo) === key);
    if (picked && !branchTouched) setBranch(picked.defaultBranch);
  }

  function toggleTarget(target: DeployTarget, checked: boolean) {
    setChosen((current) => {
      const next = { ...current };
      if (checked) next[target.id] = target.runtimes[0] ?? 'docker';
      else delete next[target.id];
      return next;
    });
  }

  const invalid =
    source === null && repository === null
      ? t('drawer.invalid.repository')
      : branch.trim() === ''
        ? t('drawer.invalid.branch')
        : deployTo === 'targets' && Object.keys(chosen).length === 0
          ? t('drawer.invalid.targets')
          : null;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalid) return;
    setPending(true);
    setError(null);
    const fields = {
      branch: branch.trim(),
      specPath: specPath.trim() || 'pupitre.json',
      watchPaths: watchText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      mode,
      deployTo,
      enabled,
      // Les cibles ne valent que pour « sur des cibles choisies » ; ailleurs,
      // c'est l'instant du commit qui dit où elle tourne.
      targets:
        deployTo === 'targets'
          ? Object.entries(chosen).map(([targetId, runtime]) => ({ targetId, runtime }))
          : [],
    };
    const response = source
      ? await fetch(`/api/applications/${applicationId}/sources/${source.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(fields),
        })
      : await fetch(`/api/applications/${applicationId}/sources`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...fields,
            repository: repository?.fullName,
            installationId: repository?.installationId,
          }),
        });
    setPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return;
    }
    toast({
      title: source
        ? t('toast.updated')
        : t('toast.linked', { repository: repository?.fullName ?? '' }),
      tone: 'ok',
    });
    onDone();
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="contents">
      <DrawerBody>
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <DrawerSection title={t('drawer.section.code')}>
          {source ? (
            <Field label={t('field.repository')} help={t('field.repository.fixed')}>
              <Input className="mono" value={source.repository} readOnly disabled />
            </Field>
          ) : (
            <Field
              label={t('field.repository')}
              error={loadError ?? undefined}
              help={
                <a
                  href={installUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="link inline-flex items-center gap-1"
                >
                  {t('field.repository.grant')}
                  <ArrowUpRight aria-hidden className="size-3" />
                </a>
              }
            >
              <Select
                className="mono"
                value={repoKey}
                disabled={repositories === null || repositories.length === 0}
                onChange={(event) => pickRepository(event.target.value)}
              >
                <option value="">
                  {repositories === null
                    ? t('field.repository.loading')
                    : repositories.length === 0 && !loadError
                      ? t('field.repository.none')
                      : t('field.repository.choose')}
                </option>
                {(repositories ?? []).map((repo) => (
                  <option key={keyOf(repo)} value={keyOf(repo)}>
                    {repo.fullName}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('field.branch')} help={t('field.branch.help')}>
              <Input
                className="mono"
                value={branch}
                placeholder="main"
                onChange={(event) => {
                  setBranch(event.target.value);
                  setBranchTouched(true);
                }}
              />
            </Field>
            <Field label={t('field.specPath')} help={t('field.specPath.help')}>
              <Input
                className="mono"
                value={specPath}
                placeholder="pupitre.json"
                onChange={(event) => setSpecPath(event.target.value)}
              />
            </Field>
          </div>
          <Field label={t('field.watchPaths')} help={t('field.watchPaths.help')} optional>
            <Textarea
              className="mono"
              rows={3}
              spellCheck={false}
              value={watchText}
              placeholder={'apps/api/**\npackages/shared/**'}
              onChange={(event) => setWatchText(event.target.value)}
            />
          </Field>
        </DrawerSection>

        <DrawerSection title={t('import.section.commits')}>
          <div
            role="radiogroup"
            aria-label={t('import.section.commits')}
            className="flex flex-col gap-2"
          >
            {DEPLOY_TO.map((option) => (
              <label
                key={option}
                className={cn(
                  'flex cursor-pointer flex-col gap-1 rounded-[10px] border border-border p-3',
                  'has-[:checked]:border-accent-line has-[:checked]:bg-accent-soft',
                  'has-[:focus-visible]:shadow-focus',
                )}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="source-deploy-to"
                    className="rd"
                    value={option}
                    checked={deployTo === option}
                    onChange={() => setDeployTo(option)}
                  />
                  <span className="t-sm font-semibold text-text">{t(`deployTo.${option}`)}</span>
                </span>
                <span className="t-sm pl-6 text-text-2">{t(`deployTo.${option}.help`)}</span>
              </label>
            ))}
          </div>
        </DrawerSection>

        {deployTo === 'targets' ? (
          <DrawerSection title={t('field.targets')}>
            <p className="help">{t('field.targets.help')}</p>
            {offered.length === 0 ? (
              <Alert variant="warn">{t('field.targets.none')}</Alert>
            ) : (
              <ul className="flex flex-col gap-2">
                {offered.map((target) => {
                  const runtime = chosen[target.id];
                  return (
                    <li key={target.id} className="flex flex-wrap items-center gap-3">
                      <CheckboxField
                        className="min-w-0 flex-1"
                        label={target.name}
                        checked={runtime !== undefined}
                        onChange={(event) => toggleTarget(target, event.target.checked)}
                      />
                      {runtime !== undefined && target.runtimes.length > 1 ? (
                        <Select
                          aria-label={t('field.targets.runtime', { target: target.name })}
                          className="w-auto"
                          value={runtime}
                          onChange={(event) =>
                            setChosen((current) => ({
                              ...current,
                              [target.id]: event.target.value as Runtime,
                            }))
                          }
                        >
                          {target.runtimes.map((option) => (
                            <option key={option} value={option}>
                              {ta(`runtime.${option}`)}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <Badge variant="outline">
                          {ta(`runtime.${runtime ?? target.runtimes[0] ?? 'docker'}`)}
                        </Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </DrawerSection>
        ) : null}

        <DrawerSection title={t('field.mode')}>
          {deployTo === 'none' ? (
            <p className="help">{t('field.mode.none')}</p>
          ) : (
            <div role="radiogroup" aria-label={t('field.mode')} className="flex flex-col gap-2">
              {MODES.map((option) => (
                <label
                  key={option}
                  className={cn(
                    'flex cursor-pointer flex-col gap-1 rounded-[10px] border border-border p-3',
                    'has-[:checked]:border-accent-line has-[:checked]:bg-accent-soft',
                    'has-[:focus-visible]:shadow-focus',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="source-mode"
                      className="rd"
                      value={option}
                      checked={mode === option}
                      onChange={() => setMode(option)}
                    />
                    <span className="t-sm font-semibold text-text">
                      {t(`mode.${option}.title`)}
                    </span>
                    {option === 'auto_unless_infra' ? (
                      <Badge variant="accent">{t('mode.recommended')}</Badge>
                    ) : null}
                  </span>
                  <span className="t-sm pl-6 text-text-2">{t(`mode.${option}.body`)}</span>
                </label>
              ))}
            </div>
          )}
          <SwitchField
            label={t('field.enabled')}
            help={t('field.enabled.help')}
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
        </DrawerSection>
      </DrawerBody>
      <DrawerFooter end={null}>
        <Button type="submit" loading={pending} disabledReason={invalid}>
          {pending ? tc('saving') : source ? t('drawer.submit.edit') : t('drawer.submit.new')}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {tc('cancel')}
        </Button>
      </DrawerFooter>
    </form>
  );
}
