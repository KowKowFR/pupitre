'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { RoleKey } from '@tp/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

type ApiErrorBody = { error?: { message?: string } };

export type CreatedUser = { id: string; email: string; name: string; roles: RoleKey[] };

/**
 * `onCreated` est le point d'extension de l'assistant de démarrage : même
 * route, même hachage du mot de passe par Better Auth, même audit. Absent, le
 * formulaire se comporte exactement comme avant.
 */
export function CreateUserForm({
  roles,
  onCreated,
}: {
  roles: readonly RoleKey[];
  onCreated?: (user: CreatedUser) => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);

    const formElement = event.currentTarget;
    const form = new FormData(formElement);

    const response = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: String(form.get('name') ?? ''),
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
        role: String(form.get('role') ?? 'viewer'),
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
      setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
      setPending(false);
      return;
    }

    const created = (await response.json().catch(() => null)) as CreatedUser | null;

    formElement.reset();
    setNotice('Utilisateur créé.');
    setPending(false);
    if (created) onCreated?.(created);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      {error ? (
        <Alert variant="destructive" className="sm:col-span-2 lg:col-span-5">
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert variant="success" className="sm:col-span-2 lg:col-span-5">
          {notice}
        </Alert>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="new-name">Nom</Label>
        <Input id="new-name" name="name" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="new-email">E-mail</Label>
        <Input id="new-email" name="email" type="email" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="new-password">Mot de passe</Label>
        <Input id="new-password" name="password" type="password" minLength={12} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="new-role">Rôle</Label>
        <Select id="new-role" name="role" defaultValue="viewer">
          {roles.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex items-end">
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? 'Création…' : 'Créer'}
        </Button>
      </div>
    </form>
  );
}
