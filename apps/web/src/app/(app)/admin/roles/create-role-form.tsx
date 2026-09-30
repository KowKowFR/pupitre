'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n/client';
import { admin } from '@/i18n/messages/admin';
import { common } from '@/i18n/messages/common';

type ApiError = { error?: { message?: string } };

/** Dérive une clé kebab-case depuis le nom saisi, sans écraser une saisie manuelle. */
export function toKey(label: string): string {
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
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <RoleIdentityFields
        label={label}
        onLabelChange={setLabel}
        roleKey={effectiveKey}
        onKeyChange={(value) => {
          setKeyTouched(true);
          setKey(value);
        }}
        taken={taken}
        description={description}
        onDescriptionChange={setDescription}
      />

      <div className="flex justify-end">
        <Button
          type="submit"
          loading={pending}
          disabled={taken || effectiveKey.length < 2 || label.trim().length < 2}
        >
          {pending ? c('creating') : t('roles.form.submit')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Nom, clé et description d'un rôle : les champs de l'assistant de démarrage
 * et de la première étape de « Nouveau rôle ». La clé suit le nom tant qu'on
 * ne l'a pas touchée.
 */
export function RoleIdentityFields({
  label,
  onLabelChange,
  roleKey,
  onKeyChange,
  taken,
  description,
  onDescriptionChange,
}: {
  label: string;
  onLabelChange: (value: string) => void;
  roleKey: string;
  onKeyChange: (value: string) => void;
  taken: boolean;
  description: string;
  onDescriptionChange: (value: string) => void;
}) {
  const t = useT(admin);
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('roles.form.name')}>
          <Input
            value={label}
            onChange={(event) => onLabelChange(event.target.value)}
            placeholder={t('roles.form.namePlaceholder')}
            required
            minLength={2}
          />
        </Field>

        <Field
          label={t('roles.form.key')}
          help={taken ? undefined : t('roles.form.keyHint')}
          error={taken ? t('roles.form.keyTaken') : undefined}
        >
          <Input
            className="mono"
            value={roleKey}
            onChange={(event) => onKeyChange(event.target.value)}
            placeholder={t('roles.form.keyPlaceholder')}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            required
          />
        </Field>
      </div>

      <Field label={t('roles.form.description')} optional>
        <Input
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          placeholder={t('roles.form.descriptionPlaceholder')}
        />
      </Field>
    </>
  );
}
