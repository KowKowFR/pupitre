'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useT } from '@/i18n/client';
import { auth as messages } from '@/i18n/messages/auth';
import { requestPasswordReset } from '@/lib/auth-client';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { AuthCard } from '../auth-card';

/**
 * Demander un lien de réinitialisation.
 *
 * ## La règle qui gouverne cet écran : il ne dit jamais qui a un compte
 *
 * « Cette adresse n'existe pas » renseignerait un inconnu sur qui travaille
 * ici. L'écran affiche donc **le même message dans les deux cas**, et ce n'est
 * pas une politesse : c'est la seule réponse qu'il connaisse. Better Auth rend
 * lui aussi un `200` identique — il va jusqu'à simuler la génération d'un jeton
 * sur le chemin « inconnu » pour que les deux durent le même temps.
 *
 * Conséquence assumée : quelqu'un qui se trompe d'adresse attendra un e-mail
 * qui ne viendra pas. Le message le dit — « si un compte existe » — plutôt que
 * de laisser croire à une panne.
 *
 * L'écran de succès remplace le formulaire au lieu de le laisser à côté : le
 * relancer dix fois ne ferait qu'atteindre la limite de débit (trois demandes
 * par minute), et un bouton qu'on peut marteler invite à le marteler.
 */
export function ForgotPasswordForm() {
  const t = useT(messages);
  const [sent, setSent] = useState(false);
  const [throttled, setThrottled] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);

    const form = new FormData(event.currentTarget);
    const result = await requestPasswordReset({
      email: String(form.get('email') ?? ''),
      // Sert de destination de repli au lien. Le texte de l'e-mail, lui, ne
      // dépend pas de ce paramètre : il est décidé côté serveur, à partir de
      // l'état du compte. Voir `sendResetPassword` dans `lib/auth.ts`.
      redirectTo: '/reset-password',
    });

    // Le seul échec qu'on distingue est la limite de débit — parce qu'elle
    // n'apprend rien sur l'existence du compte, et parce que se taire ferait
    // croire que le message est parti.
    setThrottled(result.error?.status === 429);
    setSent(true);
    setPending(false);
  }

  if (sent) {
    return (
      <AuthCard title={t('forgot.sent.title')} description={t('forgot.sent.description')}>
        {throttled ? (
          <Alert variant="destructive">{t('forgot.throttled')}</Alert>
        ) : (
          <Alert variant="info">{t('forgot.sent.notice')}</Alert>
        )}
        <Button asChild variant="secondary" className="btn-block">
          <Link href="/login">{t('link.backToLogin')}</Link>
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t('forgot.title')} description={t('forgot.description')}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label={t('field.email')}>
          <Input name="email" type="email" autoComplete="email" required autoFocus />
        </Field>
        <Button type="submit" className="btn-block" loading={pending}>
          {pending ? t('forgot.pending') : t('forgot.submit')}
        </Button>
        <p className="t-cap text-center">
          <Link href="/login" className="link">
            {t('link.backToLogin')}
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}
