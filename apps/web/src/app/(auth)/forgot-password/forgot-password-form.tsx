'use client';

import Link from 'next/link';
import { useState } from 'react';
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
          <CardTitle className="text-lg">Vérifiez votre boîte de réception</CardTitle>
          <CardDescription>
            Si un compte existe pour cette adresse, un lien vient d&apos;y être envoyé.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {throttled ? (
            <Alert variant="destructive">
              Trop de demandes depuis cette adresse IP. Attendez une minute avant de réessayer.
            </Alert>
          ) : (
            <Alert variant="info">
              Le lien ne fonctionne qu&apos;une seule fois et expire au bout d&apos;une heure.
              Choisir un nouveau mot de passe fermera toutes les sessions ouvertes sur le compte.
            </Alert>
          )}
          <Link
            href="/login"
            className="text-sm text-signal underline decoration-signal-edge underline-offset-4 hover:decoration-signal"
          >
            Retour à la connexion
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-raised">
      <CardHeader>
        <CardTitle className="text-lg">Mot de passe oublié</CardTitle>
        <CardDescription>
          Saisissez l&apos;adresse de votre compte. Un lien pour en choisir un nouveau vous y sera
          envoyé.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Adresse e-mail</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
          </div>
          <Button type="submit" className="mt-1 w-full" disabled={pending}>
            {pending ? 'Envoi…' : 'Envoyer le lien'}
          </Button>
          <p className="text-center text-xs text-ink-muted">
            <Link
              href="/login"
              className="text-signal underline decoration-signal-edge underline-offset-4 hover:decoration-signal"
            >
              Retour à la connexion
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
