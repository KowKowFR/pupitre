'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/i18n/client';
import { admin } from '@/i18n/messages/admin';
import { common } from '@/i18n/messages/common';

type ApiError = { error?: { message?: string } };

/** Dérive une clé kebab-case depuis le nom saisi, sans écraser une saisie manuelle. */
function toKey(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export type CreatedRole = { key: string; label: string };

/**
 * `onCreated` est le point d'extension de l'assistant de démarrage : même
 * route, même validation, même audit — seule la suite diffère. Absent, le
 * formulaire se comporte exactement comme avant.
 */
export function CreateRoleForm({
  existingKeys,
  onCreated,
}: {
  existingKeys: string[];
  onCreated?: (role: CreatedRole) => void;
}) {
  const router = useRouter();
  const t = useT(admin);
  const c = useT(common);
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const effectiveKey = keyTouched ? key : toKey(label);
  const taken = existingKeys.includes(effectiveKey);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const response = await fetch('/api/admin/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: effectiveKey,
        label: label.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        // Un rôle naît sans aucune permission : on les coche ensuite,
        // délibérément, plutôt que d'en accorder par défaut.
        permissions: [],
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? c('http.failure', { status: response.status }));
      setPending(false);
      return;
    }

    const created = (await response.json().catch(() => null)) as CreatedRole | null;

    setLabel('');
    setKey('');
    setKeyTouched(false);
    setDescription('');
    setPending(false);
    if (created) onCreated?.(created);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {error ? (
        <Alert variant="destructive" className="sm:col-span-2 lg:col-span-4">
          {error}
        </Alert>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="role-label">{t('roles.form.name')}</Label>
        <Input
          id="role-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={t('roles.form.namePlaceholder')}
          required
          minLength={2}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="role-key">{t('roles.form.key')}</Label>
        <Input
          id="role-key"
          value={effectiveKey}
          onChange={(event) => {
            setKeyTouched(true);
            setKey(event.target.value);
          }}
          placeholder={t('roles.form.keyPlaceholder')}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          required
          aria-invalid={taken || undefined}
        />
        <p className="text-muted-foreground text-xs">
          {taken ? t('roles.form.keyTaken') : t('roles.form.keyHint')}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="role-description">{t('roles.form.description')}</Label>
        <Input
          id="role-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t('roles.form.descriptionPlaceholder')}
        />
      </div>

      <div className="flex items-end">
        <Button
          type="submit"
          className="w-full"
          disabled={pending || taken || effectiveKey.length < 2 || label.trim().length < 2}
        >
          {pending ? c('creating') : t('roles.form.submit')}
        </Button>
      </div>
    </form>
  );
}
