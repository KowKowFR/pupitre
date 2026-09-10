import type { Metadata } from 'next';
import { eq, getDb, users } from '@tp/db';
import { PageHeader } from '@/components/page-header';
import { requirePageSession } from '@/lib/page-auth';
import { PasswordForm } from './password-form';
import { TwoFactorPanel } from './two-factor-panel';

export const metadata: Metadata = { title: 'Mon compte — Control plane' };
export const dynamic = 'force-dynamic';

/**
 * Écran « mon compte ». Aucune permission RBAC : changer son mot de passe et
 * gérer son second facteur sont des actions sur soi, pas des privilèges. Une
 * session suffit — et c'est exactement ce que vérifient les routes derrière.
 */
export default async function AccountPage() {
  const auth = await requirePageSession('/account');

  const [row] = await getDb()
    .select({ twoFactorEnabled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.id, auth.userId));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Compte"
        title="Sécurité"
        description={
          <>
            Ce qui protège l&apos;accès au panel : le mot de passe, et un second facteur qui
            survit à sa fuite. Les deux se gèrent ici, pour soi seul — un administrateur
            n&apos;a pas le pouvoir d&apos;activer un second facteur à votre place.
          </>
        }
        actions={<span className="font-mono text-xs text-ink-faint">{auth.email}</span>}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <PasswordForm />
        <TwoFactorPanel enabled={row?.twoFactorEnabled ?? false} />
      </div>
    </div>
  );
}
