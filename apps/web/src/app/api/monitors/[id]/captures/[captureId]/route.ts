import { getCaptureBytes } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid(), captureId: z.string().uuid() });
type Context = { params: Promise<{ id: string; captureId: string }> };

/**
 * Sert l'image d'une capture.
 *
 * ── Pourquoi une route et pas une URL de données dans la page ───────────────
 * Une capture pèse quelques centaines de kilo-octets ; l'écran d'une sonde en
 * affiche jusqu'à trois par incident. Les incorporer en `data:` dans le HTML
 * rendu par le serveur ferait des pages de plusieurs mégaoctets, non
 * cachables, retéléchargées à chaque navigation. Une route les rend cachables
 * par image et chargeables à la demande.
 *
 * ── Ce qu'elle protège ──────────────────────────────────────────────────────
 * `monitor:read`, comme le reste de la supervision, et **la permission est
 * vérifiée avant toute lecture d'octets**. Une capture montre la page telle
 * qu'un visiteur anonyme la voit — le navigateur ne porte aucune session — mais
 * une URL supervisée qui contient elle-même un jeton fera apparaître du contenu
 * privé sur l'image. Cette image ne doit donc jamais devenir publique : pas
 * d'accès par jeton d'URL, pas de cache partagé, pas de pièce jointe dans une
 * alerte.
 *
 * L'identifiant de la sonde est dans le chemin **et** vérifié contre la
 * capture : sans ce contrôle, la route serait une énumération d'images à
 * l'échelle de l'instance, avec un chemin qui prétend le contraire.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'monitor:read');
  const { id, captureId } = paramsSchema.parse(await context.params);

  const capture = await getCaptureBytes(captureId);
  // Une capture purgée par la rétention rend `null` : elle n'a plus d'octets,
  // et l'écran le dit déjà à partir des métadonnées. 404 est la bonne réponse.
  if (!capture || capture.monitorId !== id) {
    throw new NotFoundError(`Capture « ${captureId} » introuvable`);
  }

  return new NextResponse(new Uint8Array(capture.image), {
    status: 200,
    headers: {
      'content-type': capture.format === 'png' ? 'image/png' : 'image/jpeg',
      'content-length': String(capture.image.byteLength),
      // Une capture est **immuable** : ses octets ne changent jamais après
      // l'écriture. Le cache peut donc être long — mais `private`, parce que
      // l'image est protégée par une permission et n'a rien à faire dans un
      // cache partagé.
      'cache-control': 'private, max-age=31536000, immutable',
      // Rendue, jamais interprétée : une page capturée est du contenu tiers.
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': `inline; filename="capture-${captureId}.${capture.format}"`,
    },
  });
});
