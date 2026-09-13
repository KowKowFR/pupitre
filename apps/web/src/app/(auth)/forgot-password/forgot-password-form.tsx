'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useT } from '@/i18n/client';
import { auth as messages } from '@/i18n/messages/auth';
import { requestPasswordReset } from '@/lib/auth-client';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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
      <Card className="shadow-raised">
        <CardHeader>
          <CardTitle className="text-lg">{t('forgot.sent.title')}</CardTitle>
          <CardDescription>{t('forgot.sent.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {throttled ? (
            <Alert variant="destructive">{t('forgot.throttled')}</Alert>
          ) : (
            <Alert variant="info">{t('forgot.sent.notice')}</Alert>
          )}
          <Link
            href="/login"
            className="text-sm text-signal underline decoration-signal-edge underline-offset-4 hover:decoration-signal"
          >
            {t('link.backToLogin')}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-raised">
      <CardHeader>
        <CardTitle className="text-lg">{t('forgot.title')}</CardTitle>
        <CardDescription>{t('forgot.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">{t('field.email')}</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
          </div>
          <Button type="submit" className="mt-1 w-full" disabled={pending}>
            {pending ? t('forgot.pending') : t('forgot.submit')}
          </Button>
          <p className="text-center text-xs text-ink-muted">
            <Link
              href="/login"
              className="text-signal underline decoration-signal-edge underline-offset-4 hover:decoration-signal"
            >
              {t('link.backToLogin')}
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
