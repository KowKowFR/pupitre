'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useT } from '@/i18n/client';
import { auth as messages } from '@/i18n/messages/auth';
import { common } from '@/i18n/messages/common';
import { resetPassword } from '@/lib/auth-client';
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Choisir un mot de passe à partir d'un lien.
 *
 * **Un seul composant pour deux écrans** — accepter une invitation et
 * réinitialiser son mot de passe. Le mécanisme est rigoureusement le même : un
 * jeton à usage unique fabriqué et consommé par Better Auth, un `POST
 * /api/auth/reset-password`. Ce qui change est la situation de la personne, donc
 * les mots ; en faire deux formulaires ferait deux endroits où corriger le même
 * bug.
 *
 * Rien n'est réimplémenté ici : ni la validation du jeton, ni son expiration,
 * ni son usage unique, ni la fermeture des sessions. Cet écran saisit un mot de
 * passe et lit une réponse.
 */

export type ChoosePasswordCopy = {
  title: string;
  description: string;
  submit: string;
  /** Ce qu'on affiche quand tout s'est bien passé. */
  doneTitle: string;
  doneBody: string;
  /** Ce qu'on affiche quand le lien est mort. */
  deadTitle: string;
  deadBody: string;
};

export function ChoosePasswordForm({
  token,
  linkError,
  copy,
}: {
  /** Jeton extrait de l'URL. `null` si le lien n'en portait pas. */
  token: string | null;
  /** Code d'erreur posé par Better Auth sur le lien (`INVALID_TOKEN`…). */
  linkError: string | null;
  copy: ChoosePasswordCopy;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  /**
   * Le jeton a été refusé **à la soumission**. Distingué d'un lien mort dès
   * l'arrivée : ici la personne a tapé un mot de passe pour rien, et lui
   * réafficher le formulaire l'inviterait à recommencer indéfiniment.
   */
  const [consumed, setConsumed] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    const confirmation = String(form.get('confirmation') ?? '');

    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(t('password.tooShort', { count: PASSWORD_MIN_LENGTH }));
      return;
    }
    // Vérifiée ici et pas côté serveur : c'est une garde contre la faute de
    // frappe, pas une règle de sécurité. Le serveur n'a aucune raison de
    // recevoir deux fois la même chaîne.
    if (password !== confirmation) {
      setError(t('choose.mismatch'));
      return;
    }
    if (!token) {
      setError(t('choose.noToken'));
      return;
    }

    setPending(true);
    const result = await resetPassword({ newPassword: password, token });
    setPending(false);

    if (result.error) {
      // Un jeton refusé ne se réessaie pas : il a expiré, ou il a déjà servi.
      if (result.error.status === 400) {
        setConsumed(true);
        return;
      }
      setError(result.error.status === 429 ? t('choose.throttled') : t('choose.rejected'));
      return;
    }

    setDone(true);
  }

  if (done) {
    return (
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">{copy.doneTitle}</CardTitle>
          <CardDescription>{copy.doneBody}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            className="w-full"
            onClick={() => {
              router.push('/login');
              router.refresh();
            }}
          >
            {t('login.submit')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Lien mort — soit refusé d'entrée par le contrôle de Better Auth, soit refusé
  // à la soumission parce qu'il venait de servir.
  if (consumed || linkError || !token) {
    return (
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">{copy.deadTitle}</CardTitle>
          <CardDescription>{copy.deadBody}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="info">{t('choose.dead.notice')}</Alert>
          <div className="flex flex-col gap-2 text-sm">
            <Link
              href="/forgot-password"
              className="text-accent underline decoration-accent-line underline-offset-4 hover:decoration-accent"
            >
              {t('choose.newLink')}
            </Link>
            <Link href="/login" className="text-text-2 underline-offset-4 hover:underline">
              {t('link.backToLogin')}
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-lg">{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">{t('field.password')}</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              required
              autoFocus
            />
            <p className="text-xs text-text-3">
              {t('password.min', { count: PASSWORD_MIN_LENGTH })}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirmation">{t('field.confirmation')}</Label>
            <Input
              id="confirmation"
              name="confirmation"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              required
            />
          </div>
          <Button type="submit" className="mt-1 w-full" disabled={pending}>
            {pending ? tc('saving') : copy.submit}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
