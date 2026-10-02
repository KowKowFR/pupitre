import 'server-only';
import { logger } from '@/lib/logger';

/**
 * Les exports de fichiers du panel : journal d'un déploiement, liste des runs,
 * journal d'activité.
 *
 * Tous suivent le même contrat, écrit ici une fois :
 *
 *  - la réponse **part en flux** : le premier octet sort avant que la dernière
 *    ligne soit lue, et la mémoire ne tient jamais plus d'un lot ;
 *  - l'export est **journalisé une seule fois**, qu'il aille au bout ou qu'il
 *    soit interrompu (onglet fermé, erreur en base) — `complete` dit lequel ;
 *  - une erreur après le premier octet **coupe** le flux : impossible de
 *    repasser en 500, et un fichier tronqué vaut mieux qu'un fichier faux.
 */
export function exportResponse(options: {
  chunks: AsyncGenerator<string, void, undefined>;
  contentType: string;
  filename: string;
  /** Nom de repli quand `filename` ne contient rien d'ASCII. */
  fallbackName: string;
  /** Appelé une fois, à la fin du flux ou à son interruption. */
  onSettled: (complete: boolean) => Promise<void>;
  /** Contexte des logs d'erreur. */
  context: Record<string, unknown>;
}): Response {
  const { chunks, onSettled } = options;

  let settled = false;
  const settle = async (complete: boolean): Promise<void> => {
    if (settled) return;
    settled = true;
    await onSettled(complete);
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) {
          controller.close();
          await settle(true);
          return;
        }
        controller.enqueue(encoder.encode(value));
      } catch (error) {
        logger.error({ err: error, ...options.context }, 'export interrompu');
        controller.error(error);
        await settle(false);
      }
    },

    async cancel() {
      await chunks.return(undefined);
      await settle(false);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': options.contentType,
      'content-disposition': contentDisposition(options.filename, options.fallbackName),
      'cache-control': 'no-store',
      // nginx retiendrait le flux jusqu'à la fin sans cet en-tête.
      'x-accel-buffering': 'no',
    },
  });
}

/**
 * `content-disposition` conforme à la RFC 6266.
 *
 * Un slug est censé être en kebab-case ASCII, mais il vient de la base : rien
 * ne garantit qu'un enregistrement ancien le respecte, et un guillemet ou un
 * saut de ligne dans un en-tête casse la réponse entière. On produit donc les
 * deux formes : `filename` assaini en ASCII pour les clients anciens, et
 * `filename*` percent-encodé en UTF-8, que les navigateurs préfèrent.
 */
function contentDisposition(filename: string, fallbackName: string): string {
  const ascii = filename
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\/:*?<>|]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.\s]+|[\s.]+$/g, '');

  const fallback = ascii.length > 0 ? ascii : fallbackName;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987(filename)}`;
}

/** `encodeURIComponent` laisse passer `!'()*`, que la RFC 5987 veut encodés. */
function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()!*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
