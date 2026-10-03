'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { FileCode2, GitBranch, LoaderCircle } from 'lucide-react';
import { SOURCE_PROVIDER_LABELS, type SourceProviderKind } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { DrawerBody, DrawerFooter, DrawerSection } from '@/components/ui/drawer';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Radio } from '@/components/ui/radio';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { sources as messages } from '@/i18n/messages/sources';

/**
 * Créer une application **depuis son dépôt** : le `pupitre.json` d'une branche
 * devient l'application, liée à cette branche, sans cible imposée. On la
 * déploie ensuite où l'on veut ; les commits suivants la mettent à jour, ou la
 * redéploient là où elle tourne — au choix.
 *
 * L'AppSpec ne s'édite pas ici : elle vit dans le dépôt, et c'est le dépôt qui
 * la fait évoluer.
 */

type Repository = {
  provider: SourceProviderKind;
  fullName: string;
  installationId: number | null;
  defaultBranch: string;
  private: boolean;
};

/** Un dépôt se désigne par son fournisseur, son installation (GitHub) et son nom. */
const keyOf = (repo: Repository) =>
  `${repo.provider}:${repo.installationId ?? ''}:${repo.fullName}`;
type Specs = { branch: string; sha: string; specs: string[] };
type Preview = {
  sha: string;
  ok: boolean;
  issues: string[];
  spec: {
    name: string;
    version: string;
    services: Array<{ name: string; source: string; port: number; exposed: boolean }>;
    host: string | null;
  } | null;
};
type ApiError = { error?: { message?: string } };

async function failure(response: Response | null, fallback: string): Promise<string> {
  if (!response) return fallback;
  const body = (await response.json().catch(() => ({}))) as ApiError;
  return body.error?.message ?? fallback;
}

export function RepositoryImport({
  tabs,
  onSaved,
  onCancel,
}: {
  /** Les onglets de « Nouvelle application », gardés en tête. */
  tabs: React.ReactNode;
  onSaved: (application: { id: string; name: string }) => void;
  onCancel: () => void;
}) {
  const t = useT(messages);
  const [repositories, setRepositories] = useState<Repository[] | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('');
  const [specs, setSpecs] = useState<Specs | null>(null);
  const [searching, setSearching] = useState(false);
  const [specPath, setSpecPath] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reading, setReading] = useState(false);
  const [deployTo, setDeployTo] = useState<'none' | 'running'>('none');
  const [guardInfra, setGuardInfra] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const repo = repositories?.find((candidate) => keyOf(candidate) === repository) ?? null;
  // Le fournisseur ne se lit à côté du nom que s'il y en a plusieurs.
  const providers = new Set((repositories ?? []).map((candidate) => candidate.provider));

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/integrations/repositories', { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setConnectionError(await failure(response, t('import.unavailable')));
          setRepositories([]);
          return;
        }
        const body = (await response.json()) as {
          items: Repository[];
          errors?: Array<{ provider: string; message: string }>;
        };
        setRepositories(body.items);
        // Un fournisseur muet n'empêche pas de choisir chez les autres : on le dit.
        if (body.errors?.length) {
          setError(body.errors.map((entry) => `${entry.provider} : ${entry.message}`).join(' · '));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConnectionError(t('import.unavailable'));
          setRepositories([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  // Les pupitre.json de la branche : cherchés dès que dépôt et branche sont posés.
  useEffect(() => {
    if (!repo || branch.trim() === '') return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      setSpecs(null);
      setPreview(null);
      setError(null);
      const query = new URLSearchParams({
        provider: repo.provider,
        repository: repo.fullName,
        ...(repo.installationId !== null ? { installationId: String(repo.installationId) } : {}),
        branch: branch.trim(),
      });
      void fetch(`/api/integrations/specs?${query}`, { cache: 'no-store' })
        .then(async (response) => {
          if (cancelled) return;
          if (!response.ok) {
            setError(await failure(response, t('import.searchFailed')));
            return;
          }
          const body = (await response.json()) as Specs;
          setSpecs(body);
          // Rien de trouvé : pas d'aperçu tant qu'on n'a pas donné de chemin.
          setSpecPath(body.specs[0] ?? '');
        })
        .catch(() => !cancelled && setError(t('import.searchFailed')))
        .finally(() => !cancelled && setSearching(false));
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [repo, branch, t]);

  // L'aperçu : le fichier lu au commit en tête, validé comme un commit le serait.
  useEffect(() => {
    if (!repo || !specs || specPath.trim() === '') return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setReading(true);
      setPreview(null);
      void fetch('/api/applications/from-source', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: repo.provider,
          repository: repo.fullName,
          installationId: repo.installationId,
          branch: specs.branch,
          specPath: specPath.trim(),
          preview: true,
        }),
      })
        .then(async (response) => {
          if (cancelled) return;
          if (!response.ok) {
            setPreview({
              sha: specs.sha,
              ok: false,
              issues: [await failure(response, t('import.readFailed'))],
              spec: null,
            });
            return;
          }
          setPreview((await response.json()) as Preview);
        })
        .catch(
          () =>
            !cancelled &&
            setPreview({ sha: specs.sha, ok: false, issues: [t('import.readFailed')], spec: null }),
        )
        .finally(() => !cancelled && setReading(false));
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [repo, specs, specPath, t]);

  async function create() {
    if (!repo || !specs || !preview?.ok) return;
    setSaving(true);
    setError(null);
    const response = await fetch('/api/applications/from-source', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: repo.provider,
        repository: repo.fullName,
        installationId: repo.installationId,
        branch: specs.branch,
        specPath: specPath.trim(),
        deployTo,
        mode: guardInfra ? 'auto_unless_infra' : 'auto',
      }),
    }).catch(() => null);
    setSaving(false);
    if (!response?.ok) {
      setError(await failure(response, t('import.createFailed')));
      return;
    }
    const body = (await response.json()) as { application: { id: string; slug: string } };
    onSaved({ id: body.application.id, name: body.application.slug });
  }

  return (
    <>
      <DrawerBody>
        <DrawerSection title={t('import.section.source')}>
          <div className="flex flex-col gap-4">
            {tabs}
            <p className="t-sm text-text-2">{t('import.lead')}</p>
            {repositories === null ? (
              <p className="t-sm text-text-3">
                <LoaderCircle aria-hidden className="mr-1 inline size-3.5 animate-spin" />
                {t('field.repository.loading')}
              </p>
            ) : connectionError ? (
              <Alert variant="warn">
                {connectionError}{' '}
                <Link className="link" href="/admin/settings/integrations">
                  {t('card.notConnected.link')}
                </Link>
              </Alert>
            ) : repositories.length === 0 ? (
              <Alert>{t('field.repository.none')}</Alert>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t('field.repository')}>
                  <Select
                    value={repository}
                    onChange={(event) => {
                      const next = repositories.find(
                        (candidate) => keyOf(candidate) === event.target.value,
                      );
                      setRepository(event.target.value);
                      setBranch(next?.defaultBranch ?? '');
                    }}
                  >
                    <option value="">{t('field.repository.choose')}</option>
                    {repositories.map((candidate) => (
                      <option key={keyOf(candidate)} value={keyOf(candidate)}>
                        {providers.size > 1
                          ? `${candidate.fullName} · ${SOURCE_PROVIDER_LABELS[candidate.provider]}`
                          : candidate.fullName}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('field.branch')} help={t('import.branch.help')}>
                  <Input
                    className="mono"
                    value={branch}
                    disabled={!repo}
                    onChange={(event) => setBranch(event.target.value)}
                  />
                </Field>
              </div>
            )}
          </div>
        </DrawerSection>

        {repo ? (
          <DrawerSection title={t('import.section.spec')}>
            <div className="flex flex-col gap-3">
              {searching ? (
                <p className="t-sm text-text-3">
                  <LoaderCircle aria-hidden className="mr-1 inline size-3.5 animate-spin" />
                  {t('import.searching')}
                </p>
              ) : specs ? (
                <>
                  {specs.specs.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      <span className="t-sm font-medium">
                        {t('import.found', { count: specs.specs.length })}
                      </span>
                      {specs.specs.map((path) => (
                        <Radio
                          key={path}
                          name="spec-path"
                          checked={specPath === path}
                          onChange={() => setSpecPath(path)}
                          label={<span className="mono">{path}</span>}
                        />
                      ))}
                    </div>
                  ) : (
                    <Alert>{t('import.none', { branch: specs.branch })}</Alert>
                  )}
                  <Field label={t('field.specPath')} help={t('import.specPath.help')}>
                    <Input
                      className="mono"
                      value={specPath}
                      onChange={(event) => setSpecPath(event.target.value)}
                    />
                  </Field>
                  <p className="t-cap text-text-3">
                    <GitBranch aria-hidden className="mr-1 inline size-3.5" />
                    {t('import.commit', { branch: specs.branch, sha: specs.sha.slice(0, 7) })}
                  </p>
                </>
              ) : null}

              {reading ? (
                <p className="t-sm text-text-3">
                  <LoaderCircle aria-hidden className="mr-1 inline size-3.5 animate-spin" />
                  {t('import.reading')}
                </p>
              ) : preview ? (
                preview.ok && preview.spec ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                    <span className="flex flex-wrap items-center gap-2">
                      <FileCode2 aria-hidden className="size-4 text-text-3" />
                      <span className="t-sm font-medium">{preview.spec.name}</span>
                      <Badge variant="idle">v{preview.spec.version}</Badge>
                      {preview.spec.host ? (
                        <span className="t-cap mono text-text-3">{preview.spec.host}</span>
                      ) : null}
                    </span>
                    <ul className="flex flex-col gap-1">
                      {preview.spec.services.map((service) => (
                        <li key={service.name} className="t-sm">
                          <span className="font-medium">{service.name}</span>
                          <span className="mono text-text-3">
                            {' '}
                            — {service.source} · {service.port}
                          </span>
                          {service.exposed ? (
                            <Badge variant="ok" className="ml-2">
                              {t('import.exposed')}
                            </Badge>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <Alert variant="destructive" title={t('import.invalid')}>
                    <ul className="flex flex-col gap-0.5">
                      {preview.issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  </Alert>
                )
              ) : null}
            </div>
          </DrawerSection>
        ) : null}

        {preview?.ok ? (
          <DrawerSection title={t('import.section.commits')}>
            <div className="flex flex-col gap-2">
              <Radio
                name="deploy-to"
                checked={deployTo === 'none'}
                onChange={() => setDeployTo('none')}
                label={t('deployTo.none')}
                help={t('deployTo.none.help')}
              />
              <Radio
                name="deploy-to"
                checked={deployTo === 'running'}
                onChange={() => setDeployTo('running')}
                label={t('deployTo.running')}
                help={t('deployTo.running.help')}
              />
              {deployTo === 'running' ? (
                <div className="pl-7">
                  <CheckboxField
                    label={t('import.guardInfra')}
                    help={t('import.guardInfra.help')}
                    checked={guardInfra}
                    onChange={(event) => setGuardInfra(event.target.checked)}
                  />
                </div>
              ) : null}
            </div>
          </DrawerSection>
        ) : null}
        {error ? <Alert variant="destructive">{error}</Alert> : null}
      </DrawerBody>
      <DrawerFooter
        end={preview?.ok ? <span className="t-cap text-text-3">{t('import.saveNote')}</span> : null}
      >
        <Button loading={saving} disabled={!preview?.ok} onClick={() => void create()}>
          {t('import.create')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('import.cancel')}
        </Button>
      </DrawerFooter>
    </>
  );
}
