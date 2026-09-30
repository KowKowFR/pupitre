'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { RoleKey } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { admin } from '@/i18n/messages/admin';
import { common } from '@/i18n/messages/common';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';

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
  const t = useT(admin);
  const c = useT(common);
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
      setError(body.error?.message ?? c('http.failure', { status: response.status }));
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
      setNotice(t('users.created.notice'));
    } else if (created?.invitation?.sent) {
      setNotice(t('users.invited.notice', { email }));
    } else {
      setError(
        t('users.invited.failed', {
          email,
          reason: created?.invitation?.error ?? t('users.reason.unknown'),
        }),
      );
    }

    if (created) onCreated?.(created);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {notice ? <Alert variant="success">{notice}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('users.form.name')}>
          <Input name="name" required />
        </Field>
        <Field label={t('users.form.email')}>
          <Input name="email" type="email" required />
        </Field>
        {canInvite ? null : (
          <Field label={t('users.form.password')}>
            <Input
              name="password"
              type="password"
              minLength={PASSWORD_MIN_LENGTH}
              autoComplete="new-password"
              required
            />
          </Field>
        )}
        <Field label={t('users.form.role')}>
          <Select name="role" defaultValue="viewer">
            {roles.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={pending}>
          {pending
            ? canInvite
              ? t('users.form.sending')
              : c('creating')
            : canInvite
              ? t('users.form.invite')
              : t('users.form.create')}
        </Button>
      </div>
    </form>
  );
}
