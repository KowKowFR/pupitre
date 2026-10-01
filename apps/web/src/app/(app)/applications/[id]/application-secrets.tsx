'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, KeyRound, Link2, RefreshCw, Trash2, X } from 'lucide-react';
import type { SecretView } from '@/lib/application-secrets';
import { Alert } from '@/components/ui/alert';
import { Badge, CodeBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SecretInput } from '@/components/ui/field';
import { IconButton } from '@/components/ui/tooltip';
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
  deployedAt,
}: {
  applicationId: string;
  secrets: SecretView[];
  canEdit: boolean;
  /**
   * Départ du dernier déploiement réussi. Une valeur posée après lui ne tourne
   * pas encore : le `.env` ou le Secret Kubernetes se rendent au déploiement.
   */
  deployedAt: string | null;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  // Modifiés après le dernier déploiement réussi, donc pas encore en service.
  // Un alias suit son secret : il est en attente quand sa source l'est.
  const changed = new Set(
    deployedAt
      ? secrets
          .filter((secret) => !secret.aliasOf && secret.updatedAt && secret.updatedAt > deployedAt)
          .map((secret) => secret.name)
      : [],
  );
  const pending = secrets
    .filter((secret) => changed.has(secret.aliasOf ?? secret.name) && secret.declared)
    .map((secret) => secret.name);
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

  /** Le geste en attente de confirmation : régénérer ou effacer une valeur. */
  const [confirming, setConfirming] = useState<{ name: string; action: 'regenerate' | 'delete' } | null>(
    null,
  );

  async function confirmAction() {
    if (!confirming) return;
    const { name, action } = confirming;
    const done =
      action === 'regenerate'
        ? await call(name, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ generate: true }),
          })
        : await call(name, { method: 'DELETE' });
    if (done) setConfirming(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('secrets.title')}</CardTitle>
        <CardDescription>
          {t('secrets.description.1')}
          <code className="code mx-1">MASTER_KEY</code>
          {t('secrets.description.2')}{' '}
          <strong className="font-medium text-text">{t('secrets.description.3')}</strong>{' '}
          {t('secrets.description.4')}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {secrets.length === 0 ? <p className="t-sm text-text-2">{t('secrets.none')}</p> : null}

        {pending.length > 0 ? (
          <Alert variant="warn" title={t('secrets.pending.title', { count: pending.length })}>
            {t('secrets.pending.body')}
          </Alert>
        ) : null}

        <ul className="flex flex-col divide-y divide-border-subtle">
          {secrets.map((secret) => (
            <li key={secret.name} className="flex flex-wrap items-center gap-3 py-3">
              {secret.aliasOf ? (
                <Link2 className="size-4 shrink-0 text-text-3" />
              ) : (
                <KeyRound className="size-4 shrink-0 text-text-3" />
              )}

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mono text-[12.5px] font-semibold text-text">{secret.name}</span>

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
                  {pending.includes(secret.name) ? (
                    <Badge variant="warn" dot>
                      {t('secrets.badge.pending')}
                    </Badge>
                  ) : null}
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
                  <span className="sm:w-72">
                    <SecretInput
                      autoFocus
                      value={draft}
                      placeholder={t('secrets.newValue')}
                      aria-label={t('secrets.newValue')}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') submit(secret.name);
                        if (event.key === 'Escape') setEditing(null);
                      }}
                    />
                  </span>
                  <IconButton
                    label={tc('save')}
                    variant="default"
                    disabled={busy === secret.name}
                    onClick={() => submit(secret.name)}
                  >
                    <Check />
                  </IconButton>
                  <IconButton label={tc('cancel')} onClick={() => setEditing(null)}>
                    <X />
                  </IconButton>
                </div>
              ) : null}

              {canEdit && !secret.aliasOf && editing !== secret.name ? (
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy === secret.name}
                    onClick={() => {
                      setEditing(secret.name);
                      setDraft('');
                    }}
                  >
                    {secret.isSet ? t('secrets.replace') : t('secrets.setNow')}
                  </Button>
                  <IconButton
                    label={t('secrets.regenerate.label', { name: secret.name })}
                    size="icon-sm"
                    disabled={busy === secret.name}
                    onClick={() => setConfirming({ name: secret.name, action: 'regenerate' })}
                  >
                    <RefreshCw />
                  </IconButton>
                  {secret.declared ? null : (
                    <IconButton
                      label={t('secrets.delete.label', { name: secret.name })}
                      size="icon-sm"
                      className="text-danger-text"
                      disabled={busy === secret.name}
                      onClick={() => setConfirming({ name: secret.name, action: 'delete' })}
                    >
                      <Trash2 />
                    </IconButton>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => (open ? undefined : setConfirming(null))}
        level={confirming?.action === 'regenerate' ? 'data' : 'trace'}
        icon={confirming?.action === 'regenerate' ? <RefreshCw /> : undefined}
        title={
          confirming
            ? t(
                confirming.action === 'regenerate'
                  ? 'secrets.regenerate.dialog.title'
                  : 'secrets.delete.dialog.title',
                { name: confirming.name },
              )
            : ''
        }
        consequences={
          confirming?.action === 'regenerate'
            ? [
                t('secrets.regenerate.consequence.draw'),
                t('secrets.regenerate.consequence.next'),
                t('secrets.regenerate.consequence.data'),
              ]
            : [t('secrets.delete.consequence.gone'), t('secrets.delete.consequence.orphan')]
        }
        retypeName={confirming?.action === 'regenerate' ? confirming.name : undefined}
        confirmLabel={confirming?.action === 'regenerate' ? t('secrets.regenerate.action') : tc('delete')}
        pending={confirming !== null && busy === confirming.name}
        error={confirming ? error : null}
        onConfirm={confirmAction}
      />
    </Card>
  );
}
