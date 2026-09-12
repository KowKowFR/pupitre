'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { RoleKey } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { cn } from '@/lib/utils';

type ApiErrorBody = { error?: { message?: string } };

export type CreatedUser = {
  id: string;
  email: string;
  name: string;
  roles: RoleKey[];
  /** Verdict de l'envoi, `null` quand le compte a été créé avec un mot de passe. */
  invitation: { sent: boolean; channel: string | null; error: string | null } | null;
};

/**
 * Un seul formulaire, deux régimes — et **jamais les deux à la fois**.
 *
 * `canInvite` n'est pas une préférence d'affichage : c'est la capacité de
 * l'instance. Quand un canal SMTP actif existe, le champ « mot de passe »
 * disparaît purement et simplement, et l'administrateur ne peut plus fabriquer
 * un mot de passe qu'il devrait ensuite transmettre par un canal quelconque.
 * Quand il n'y en a pas — l'état d'une instance neuve —, c'est le seul chemin
 * possible, et l'écran le dit au lieu de proposer une invitation qui ne
 * partirait pas.
 *
 * C'est la réponse à « garder le formulaire à côté de l'invitation laisse deux
 * façons de faire la même chose » : il n'y en a jamais deux devant les yeux
 * d'un opérateur.
 *
 * `onCreated` est le point d'extension de l'assistant de démarrage : même
 * route, même audit. Absent, le formulaire se comporte comme sur `/admin/users`.
 */
export function CreateUserForm({
  roles,
  canInvite,
  onCreated,
}: {
  roles: readonly RoleKey[];
  /** L'instance sait-elle envoyer un e-mail ? Décide du régime du formulaire. */
  canInvite: boolean;
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

    const email = String(form.get('email') ?? '');

    const response = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: String(form.get('name') ?? ''),
        email,
        // Champ omis en régime invitation : c'est son absence qui dit à la
        // route « invite au lieu de créer ». Envoyer une chaîne vide ferait
        // échouer la validation au lieu de basculer de régime.
        ...(canInvite ? {} : { password: String(form.get('password') ?? '') }),
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
    setPending(false);

    // Le compte existe dans tous les cas ; l'e-mail, lui, a pu ne pas partir.
    // Dire « invitation envoyée » sans le savoir serait exactement le silence
    // que ce parcours doit éviter.
    if (!canInvite) {
      setNotice('Utilisateur créé. Transmettez-lui son mot de passe par un canal sûr.');
    } else if (created?.invitation?.sent) {
      setNotice(`Invitation envoyée à ${email}. Le lien est valable 72 heures, une seule fois.`);
    } else {
      setError(
        `Le compte de ${email} est créé, mais l’invitation n’est pas partie : ` +
          `${created?.invitation?.error ?? 'raison inconnue'}. Relancez-la depuis la liste.`,
      );
    }

    if (created) onCreated?.(created);
    router.refresh();
  }

  return (
    <form
      onSubmit={onSubmit}
      className={cn('grid gap-4 sm:grid-cols-2', canInvite ? 'lg:grid-cols-4' : 'lg:grid-cols-5')}
    >
      {error ? (
        <Alert variant="destructive" className="sm:col-span-2 lg:col-span-full">
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert variant="success" className="sm:col-span-2 lg:col-span-full">
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
      {canInvite ? null : (
        <div className="space-y-1.5">
          <Label htmlFor="new-password">Mot de passe</Label>
          <Input
            id="new-password"
            name="password"
            type="password"
            minLength={PASSWORD_MIN_LENGTH}
            required
          />
        </div>
      )}
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
          {pending
            ? canInvite
              ? 'Envoi…'
              : 'Création…'
            : canInvite
              ? 'Inviter'
              : 'Créer'}
        </Button>
      </div>
    </form>
  );
}
