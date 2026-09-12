import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';

/**
 * 404 **dans** le panel — celle que rend un `notFound()` appelé depuis une
 * page de section, typiquement un identifiant qui n'existe plus en base.
 *
 * Elle existe séparément de `app/not-found.tsx` pour une seule raison : rendue
 * ici, elle garde le rail de navigation. Perdre la navigation parce qu'un
 * déploiement a été purgé serait une punition disproportionnée.
 */
export default function AppNotFound() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Introuvable"
        title="Rien à cette adresse"
        description="L'objet demandé n'existe pas, ou plus."
      />
      <Card>
        <CardContent className="space-y-3">
          <p className="text-[0.8125rem] text-ink-muted">
            Un déploiement purgé, une application supprimée ou une cible retirée laissent leurs
            liens derrière eux. Le rail de navigation à gauche reste utilisable.
          </p>
          <Link
            href="/"
            className="inline-block text-sm text-signal underline decoration-signal-edge underline-offset-4 hover:decoration-signal"
          >
            Retour au tableau de bord
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
