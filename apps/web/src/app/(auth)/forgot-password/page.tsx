import type { Metadata } from 'next';
import Link from 'next/link';
import { canSendAccountMail } from '@/lib/account-mail';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ForgotPasswordForm } from './forgot-password-form';

export const metadata: Metadata = { title: 'Mot de passe oublié — Pupitre' };
export const dynamic = 'force-dynamic';

/**
 * Sans canal e-mail, le formulaire n'est pas affiché.
 *
 * C'est le point que ce chantier tenait à ne pas rater : un écran qui accepte
 * une adresse, remercie, et n'envoie rien, est pire que pas d'écran du tout —
 * la personne attend un message qui ne peut pas exister, et conclut que le
 * panel est cassé. Ici elle lit ce qui se passe réellement, et à qui s'adresser.
 *
 * Le lien vers cette page est masqué sur l'écran de connexion dans le même cas :
 * les deux lisent la même fonction, il n'y a donc pas deux vérités.
 */
export default async function ForgotPasswordPage() {
  if (!(await canSendAccountMail())) {
    return (
      <Card className="shadow-raised">
        <CardHeader>
          <CardTitle className="text-lg">Réinitialisation indisponible</CardTitle>
          <CardDescription>
            Cette instance n&apos;a aucun canal e-mail configuré : elle ne peut envoyer aucun lien.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="info">
            Demandez à un administrateur de vous redonner un accès. Il peut configurer un serveur
            SMTP dans <span className="font-medium">Paramètres → Notifications</span> pour que ce
            parcours fonctionne.
          </Alert>
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

  return <ForgotPasswordForm />;
}
