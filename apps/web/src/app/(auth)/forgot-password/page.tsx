import type { Metadata } from 'next';
import Link from 'next/link';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';
import { canSendAccountMail } from '@/lib/account-mail';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AuthCard } from '../auth-card';
import { ForgotPasswordForm } from './forgot-password-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.forgot') };
}

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
    const t = await getT(messages);

    return (
      <AuthCard
        title={t('forgot.unavailable.title')}
        description={t('forgot.unavailable.description')}
      >
        <Alert variant="warn">
          {t('forgot.unavailable.hint.before')} <strong>{t('forgot.unavailable.hint.path')}</strong>{' '}
          {t('forgot.unavailable.hint.after')}
        </Alert>
        <Button asChild variant="secondary" className="btn-block">
          <Link href="/login">{t('link.backToLogin')}</Link>
        </Button>
      </AuthCard>
    );
  }

  return <ForgotPasswordForm />;
}
