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
      setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
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
    const confirmed = window.confirm(
      `Régénérer « ${name} » ?\n\n` +
        "La nouvelle valeur ne prendra effet qu'au prochain déploiement, et les données " +
        'déjà écrites avec l’ancienne (le volume d’une base, par exemple) ne la connaîtront ' +
        'pas. À ne faire que sur une application neuve ou après avoir migré les données.',
    );
    if (!confirmed) return;
    void call(name, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ generate: true }),
    });
  }

  function remove(name: string) {
    if (!window.confirm(`Supprimer définitivement la valeur de « ${name} » ?`)) return;
    void call(name, { method: 'DELETE' });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Secrets</CardTitle>
        <CardDescription>
          L&apos;AppSpec ne déclare que des noms ; les valeurs vivent chiffrées en base, sous
          <code className="mx-1 font-mono text-xs">MASTER_KEY</code>, et ne sont déchiffrées que
          par le worker au moment du rendu. Elles sont attachées à l&apos;application, pas au
          déploiement : un redéploiement réutilise la même valeur, sans quoi le volume d&apos;une
          base déjà initialisée deviendrait inaccessible.{' '}
          <strong className="font-medium text-ink">
            Un nom peut reprendre la valeur d&apos;un autre
          </strong>{' '}
          — l&apos;application et sa base attendent souvent le même mot de passe sous deux noms
          différents. Il n&apos;y a alors qu&apos;une valeur, et un seul endroit où la changer.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {secrets.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Cette application ne déclare aucun secret.
          </p>
        ) : null}

        <ul className="divide-y divide-line">
          {secrets.map((secret) => (
            <li key={secret.name} className="flex flex-wrap items-center gap-3 py-3">
              {secret.aliasOf ? (
                <Link2 className="size-4 shrink-0 text-ink-faint" />
              ) : (
                <KeyRound className="size-4 shrink-0 text-ink-faint" />
              )}

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[0.8125rem] text-ink">{secret.name}</span>

                  {secret.aliasOf ? <Badge variant="secondary">alias</Badge> : null}

                  {secret.isSet ? (
                    <Badge variant="ok">définie</Badge>
                  ) : (
                    // Pas « manquante » : le worker en génère une avant le
                    // rendu. Un secret déclaré ne peut donc pas bloquer un
                    // déploiement — l'écran ne doit pas laisser croire l'inverse.
                    <Badge variant="warn">générée au déploiement</Badge>
                  )}

                  {secret.origin === 'generated' ? (
                    <Badge variant="secondary">générée</Badge>
                  ) : null}
                  {secret.origin === 'provided' ? <Badge variant="outline">saisie</Badge> : null}
                  {secret.declared ? null : <Badge variant="warn">plus déclarée</Badge>}
                </div>

                <p className="mt-0.5 text-xs text-ink-faint">
                  {secret.declared ? (
                    <>
                      réclamée par{' '}
                      {secret.services.map((service) => (
                        <CodeBadge key={service} className="mr-1">
                          {service}
                        </CodeBadge>
                      ))}
                    </>
                  ) : (
                    "aucun service de l'AppSpec courante ne la réclame — conservée tant qu'elle n'est pas supprimée à la main"
                  )}
                </p>

                {/* D'où vient la valeur, ou qui d'autre la lit. Sans cette
                    ligne, deux noms portant le même mot de passe se lisent
                    comme deux secrets indépendants. */}
                {secret.aliasOf ? (
                  <p className="mt-0.5 text-xs text-ink-faint">
                    reprend la valeur de <CodeBadge>{secret.aliasOf}</CodeBadge> — aucune valeur
                    propre, aucune ligne en base
                  </p>
                ) : null}

                {secret.readAs.length > 0 ? (
                  <p className="mt-0.5 text-xs text-ink-faint">
                    lue aussi sous{' '}
                    {secret.readAs.map((alias) => (
                      <CodeBadge key={alias} className="mr-1">
                        {alias}
                      </CodeBadge>
                    ))}
                  </p>
                ) : null}
              </div>

              {canEdit && secret.aliasOf ? (
                <span className="text-xs text-ink-faint">
                  se modifie sur « {secret.aliasOf} »
                </span>
              ) : null}

              {canEdit && !secret.aliasOf && editing === secret.name ? (
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <Input
                    autoFocus
                    type="password"
                    value={draft}
                    placeholder="nouvelle valeur"
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
                    aria-label="Enregistrer"
                    disabled={busy === secret.name}
                    onClick={() => submit(secret.name)}
                  >
                    <Check className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Annuler"
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
                    {secret.isSet ? 'Remplacer' : 'Saisir maintenant'}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Régénérer ${secret.name}`}
                    title="Tirer une nouvelle valeur au sort"
                    disabled={busy === secret.name}
                    onClick={() => regenerate(secret.name)}
                  >
                    <RefreshCw className="size-4" />
                  </Button>
                  {secret.declared ? null : (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Supprimer ${secret.name}`}
                      title="Supprimer définitivement"
                      disabled={busy === secret.name}
                      onClick={() => remove(secret.name)}
                    >
                      <Trash2 className="size-4 text-danger" />
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
