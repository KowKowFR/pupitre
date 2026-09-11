import type { ReactNode } from 'react';
import { getAppSettings } from '@tp/db';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { requirePagePermission } from '@/lib/page-auth';
import { SettingsNav } from './settings-nav';

export const dynamic = 'force-dynamic';

/**
 * Coquille des paramètres.
 *
 * Les réglages sont découpés en pages, pas en onglets : chaque section est une
 * adresse, rendue sur le serveur, partageable dans un ticket, et dont le code
 * client ne charge que ce qu'elle affiche. La page unique empilait tout — et
 * n'aurait fait qu'empirer, puisqu'un réglage s'ajoute sans migration.
 *
 * Le layout porte ce qui est commun à toutes les sections : le bandeau de
 * page, le rail, et la mention de lecture seule. La poser ici plutôt que dans
 * chaque formulaire évite de la répéter cinq fois et garantit qu'aucune
 * section ne l'oublie.
 *
 * La permission est vérifiée ici **et** dans chaque page. Ce n'est pas de la
 * redondance décorative : un layout n'est pas réexécuté quand on navigue entre
 * deux de ses enfants côté client, seule la page l'est.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const auth = await requirePagePermission('/admin/settings', 'settings:read');
  const record = await getAppSettings();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Administration"
        title="Paramètres"
        description={
          <>
            Réglages de l&apos;instance, appliqués à chaud. Ils vivent dans une ligne unique de{' '}
            <code className="font-mono text-xs">app_settings</code> — un seul JSONB, pour
            qu&apos;ajouter un réglage ne coûte pas une migration. La clé d&apos;API, elle, est
            chiffrée dans sa propre colonne et ne ressort jamais d&apos;ici.
          </>
        }
        actions={
          <span className="font-mono text-xs text-ink-faint">
            {record.updatedAt ? 'personnalisés' : 'valeurs par défaut'}
          </span>
        }
      />

      <div className="grid gap-x-8 gap-y-4 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
        <SettingsNav />
        <div className="flex min-w-0 flex-col gap-5">
          {auth.can('settings:manage') ? null : (
            <Alert>
              Lecture seule : la permission{' '}
              <code className="font-mono text-xs">settings:manage</code> est requise pour modifier
              ces réglages. Les sections restent consultables, leurs champs sont inactifs.
            </Alert>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
