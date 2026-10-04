import 'server-only';
import { logger } from '@/lib/logger';

/**
 * The panel's file exports: a deployment's log, the runs list, the activity log.
 *
 * All follow the same contract, written here once:
 *
 *  - the response **goes out as a stream**: the first byte goes out before the
 *    last line is read, and the memory never holds more than one batch;
 *  - the export is **logged only once**, whether it goes to the end or is
 *    interrupted (tab closed, database error) — `complete` says which;
 *  - an error after the first byte **cuts** the stream: impossible to switch back
 *    to a 500, and a truncated file is better than a wrong file.
 */
export function exportResponse(options: {
  chunks: AsyncGenerator<string, void, undefined>;
  contentType: string;
  filename: string;
  /** The fallback name when `filename` contains nothing ASCII. */
  fallbackName: string;
  /** Called once, at the end of the stream or at its interruption. */
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
        logger.error({ err: error, ...options.context }, 'export interrupted');
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
      // nginx would hold the stream back until the end without this header.
      'x-accel-buffering': 'no',
    },
  });
}

/**
 * A `content-disposition` conforming to RFC 6266.
 *
 * A slug is supposed to be ASCII kebab-case, but it comes from the database:
 * nothing guarantees that an old record respects it, and a quote or a line break
 * in a header breaks the whole response. So we produce both forms: `filename`
 * sanitized to ASCII for old clients, and `filename*` percent-encoded in UTF-8,
 * which browsers prefer.
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

/** `encodeURIComponent` lets `!'()*` through, which RFC 5987 wants encoded. */
function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()!*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
