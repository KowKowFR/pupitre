'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, KeyRound, Link2, RefreshCw, Trash2, X } from 'lucide-react';
import type { SecretView } from '@/lib/application-secrets';
import { Alert } from '@/components/ui/alert';
import { Badge, CodeBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { applications as messages } from '@/i18n/messages/applications';

type ApiError = { error?: { message?: string } };

/**
 * Écran des secrets d'une application.
 *
 * Il dit qu'un secret est **défini**, jamais ce qu'il vaut : aucune route ne
 * rend une valeur, et un composant ne saurait donc pas l'afficher même s'il le
 * voulait. Un secret généré par le panel n'a d'ailleurs aucune raison d'être lu
 * — personne n'a besoin de connaître le mot de passe que l'application utilise
 * pour joindre sa propre base. Un secret saisi, lui, doit pouvoir être
 * **remplacé** : c'est le seul geste que cet écran propose sur une valeur.
 */
export function ApplicationSecrets({
  applicationId,
  secrets,
  canEdit,
}: {
  applicationId: string;
  secrets: SecretView[];
  canEdit: boolean;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  async function call(name: string, init: RequestInit) {
    setBusy(name);
    setError(null);
    const response = await fetch(
      `/api/applications/${applicationId}/secrets/${encodeURIComponent(name)}`,
      init,
    );
    setBusy(null);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return false;
    }
    setEditing(null);
    setDraft('');
    router.refresh();
    return true;
  }

  function submit(name: string) {
    void call(name, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: draft }),
    });
  }

  function regenerate(name: string) {
    const confirmed = window.confirm(t('secrets.regenerate.confirm', { name }));
    if (!confirmed) return;
    void call(name, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ generate: true }),
    });
  }

  function remove(name: string) {
    if (!window.confirm(t('secrets.delete.confirm', { name }))) return;
    void call(name, { method: 'DELETE' });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('secrets.title')}</CardTitle>
        <CardDescription>
          {t('secrets.description.1')}
          <code className="mx-1 font-mono text-xs">MASTER_KEY</code>
          {t('secrets.description.2')}{' '}
          <strong className="font-medium text-text">{t('secrets.description.3')}</strong>{' '}
          {t('secrets.description.4')}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {secrets.length === 0 ? <p className="text-sm text-text-2">{t('secrets.none')}</p> : null}

        <ul className="divide-y divide-border">
          {secrets.map((secret) => (
            <li key={secret.name} className="flex flex-wrap items-center gap-3 py-3">
              {secret.aliasOf ? (
                <Link2 className="size-4 shrink-0 text-text-3" />
              ) : (
                <KeyRound className="size-4 shrink-0 text-text-3" />
              )}

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[0.8125rem] text-text">{secret.name}</span>

                  {secret.aliasOf ? (
                    <Badge variant="secondary">{t('secrets.badge.alias')}</Badge>
                  ) : null}

                  {secret.isSet ? (
                    <Badge variant="ok">{t('secrets.badge.set')}</Badge>
                  ) : (
                    // Pas « manquante » : le worker en génère une avant le
                    // rendu. Un secret déclaré ne peut donc pas bloquer un
                    // déploiement — l'écran ne doit pas laisser croire l'inverse.
                    <Badge variant="warn">{t('secrets.badge.generatedAtDeploy')}</Badge>
                  )}

                  {secret.origin === 'generated' ? (
                    <Badge variant="secondary">{t('secrets.badge.generated')}</Badge>
                  ) : null}
                  {secret.origin === 'provided' ? (
                    <Badge variant="outline">{t('secrets.badge.provided')}</Badge>
                  ) : null}
                  {secret.declared ? null : (
                    <Badge variant="warn">{t('secrets.badge.undeclared')}</Badge>
                  )}
                </div>

                <p className="mt-0.5 text-xs text-text-3">
                  {secret.declared ? (
                    <>
                      {t('secrets.claimedBy')}
                      {secret.services.map((service) => (
                        <CodeBadge key={service} className="mr-1">
                          {service}
                        </CodeBadge>
                      ))}
                    </>
                  ) : (
                    t('secrets.orphan')
                  )}
                </p>

                {/* D'où vient la valeur, ou qui d'autre la lit. Sans cette
                    ligne, deux noms portant le même mot de passe se lisent
                    comme deux secrets indépendants. */}
                {secret.aliasOf ? (
                  <p className="mt-0.5 text-xs text-text-3">
                    {t('secrets.aliasOf.before')}
                    <CodeBadge>{secret.aliasOf}</CodeBadge>
                    {t('secrets.aliasOf.after')}
                  </p>
                ) : null}

                {secret.readAs.length > 0 ? (
                  <p className="mt-0.5 text-xs text-text-3">
                    {t('secrets.readAs')}{' '}
                    {secret.readAs.map((alias) => (
                      <CodeBadge key={alias} className="mr-1">
                        {alias}
                      </CodeBadge>
                    ))}
                  </p>
                ) : null}
              </div>

              {canEdit && secret.aliasOf ? (
                <span className="text-xs text-text-3">
                  {t('secrets.editOnRoot', { name: secret.aliasOf })}
                </span>
              ) : null}

              {canEdit && !secret.aliasOf && editing === secret.name ? (
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <Input
                    autoFocus
                    type="password"
                    value={draft}
                    placeholder={t('secrets.newValue')}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') submit(secret.name);
                      if (event.key === 'Escape') setEditing(null);
                    }}
                    className="sm:w-64"
                  />
                  <Button
                    size="icon"
                    variant="default"
                    aria-label={tc('save')}
                    disabled={busy === secret.name}
                    onClick={() => submit(secret.name)}
                  >
                    <Check className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={tc('cancel')}
                    onClick={() => setEditing(null)}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ) : null}

              {canEdit && !secret.aliasOf && editing !== secret.name ? (
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === secret.name}
                    onClick={() => {
                      setEditing(secret.name);
                      setDraft('');
                    }}
                  >
                    {secret.isSet ? t('secrets.replace') : t('secrets.setNow')}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('secrets.regenerate.label', { name: secret.name })}
                    title={t('secrets.regenerate.title')}
                    disabled={busy === secret.name}
                    onClick={() => regenerate(secret.name)}
                  >
                    <RefreshCw className="size-4" />
                  </Button>
                  {secret.declared ? null : (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t('secrets.delete.label', { name: secret.name })}
                      title={t('secrets.delete.title')}
                      disabled={busy === secret.name}
                      onClick={() => remove(secret.name)}
                    >
                      <Trash2 className="size-4 text-danger-text" />
                    </Button>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
